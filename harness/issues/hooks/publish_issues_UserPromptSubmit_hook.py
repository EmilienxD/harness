#!/usr/bin/env python3
"""UserPromptSubmit hook: publishes drafted GitHub issues from .issues-gateway/.

Fires before Claude ever sees the prompt. When the prompt is "/publish-issues"
or "/publish-issue" (optionally with "--dry"), this script does all the
work itself with `gh` and exits 2, which erases the prompt and shows stderr to
the user only - zero API calls for this step.

Design notes:
- Each batch lives in its own directory: ".issues-gateway/{session-id}/",
  where the session id is the Claude Code session id the drafting run had
  (${CLAUDE_SESSION_ID}). It is unique per session by construction, so no
  collision handling is needed.
- Draft files inside a batch dir are named "issue-{i}.md". Sorting by `i`
  gives a stable creation order, so an issue can only reference an issue
  created earlier in the same batch (no forward references), assuming
  /draft-issues emitted a correct topological order. This script no longer
  *assumes* that ordering is perfect - see the retry pass below.
- The first "# " header line in a draft file is the issue title. The first
  non-empty line after that declares labels (see /draft-issues, /draft-issue,
  /to-spec-draft-issue): either "> difficulty:{low|medium|high}, mode:{afk|hitl}"
  or "> spec". It is parsed and mapped to flat label names
  ("low-difficulty", "medium-difficulty", "high-difficulty", "afk", "hitl",
  "spec") via LABEL_ALIASES, then stripped from the body that gets posted,
  since the labels carry that information from then on.
- A reference to another draft issue, written as "{session-id}/{i}" in the body, is
  rewritten to "#<real-issue-number>" once that draft has been published.
  This is how "blocked by" links get resolved without creating issues
  sequentially inside the agent loop.
- Resolution survives across separate invocations of this hook: once an
  issue is published, its file is renamed to encode the real issue number
  ("issue-{i}-#{number}.md") before being moved into the batch's
  ".published/" folder. On every run, "resolved" is rebuilt by reading
  those filenames back, not kept only in memory - so a partial failure
  followed by a rerun doesn't get stuck thinking earlier, already-published
  issues in the batch don't exist.
- Within a single run, unresolved references are retried in a worklist loop
  rather than skipped once and left for a manual rerun - this self-heals
  ordering mistakes (e.g. a diamond dependency the model numbered wrong)
  and only reports a failure for references that are still unresolved after
  every file that *could* make progress has been tried.
- The body is always passed to `gh` via --body-file (a temp file), never
  inline on the command line. This is what avoids the Windows command-line
  length limit, on every platform, regardless of body size.
- "--dry" runs the exact same parse/resolve logic but never calls
  `gh issue create` and never moves/renames files - it reports what would
  happen, so a bad label line or a genuinely unresolvable reference can be
  caught before anything touches the tracker.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

GATEWAY_DIR = Path(".issues-gateway")

# "/publish-issue", "/publish-issues", and their "--dry" variants match.
PROMPT_PATTERN = re.compile(r"^/publish-issues?(?:\s|$)")

# A reference to another draft issue inside a body, e.g.
# "{6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55/0}"
REF_PATTERN = re.compile(r"\{([0-9a-zA-Z_-]+)/(\d+)\}")

# A batch directory name: a Claude Code session id (a UUID).
SESSION_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# The draft filename convention produced by /draft-issues: "issue-{i}.md"
FILENAME_PATTERN = re.compile(r"^issue-(\d+)\.md$")

# The filename convention for an already-published file, which encodes the
# real issue number so it can be recovered on a later run:
# "issue-{i}-#{number}.md"
PUBLISHED_FILENAME_PATTERN = re.compile(r"^issue-(\d+)-#(\d+)\.md$")

# The label declaration line produced by /draft-issues or /draft-issue, e.g.
# "> difficulty:medium, mode:hitl". Tolerant of leading whitespace before
# the ">" and of surrounding spaces around the comma.
LABEL_LINE_PATTERN = re.compile(
    r"^\s*>\s*(difficulty:(?:low|medium|high))\s*,\s*(mode:(?:afk|hitl))\s*$",
    re.IGNORECASE,
)

# The label declaration line produced by /to-spec-draft-issue.
SPEC_LABEL_LINE_PATTERN = re.compile(r"^\s*>\s*spec\s*$", re.IGNORECASE)

# Canonical labels this workflow depends on: (color, description). Created
# (or updated) with --force at the start of every publish run, so they
# always exist regardless of repo state.
CANONICAL_LABELS = {
    "low-difficulty": ("0E8A16", "Routine, well-understood work - safe for a lighter model."),
    "medium-difficulty": ("FBCA04", "Multi-step work with real design decisions."),
    "high-difficulty": ("D93F0B", "Needs careful judgment, wide context, or unusual reasoning."),
    "afk": ("1D76DB", "Safe to implement in one shot, no review needed before landing."),
    "hitl": ("5319E7", "Sensitive, design-touching, or complex - needs human review."),
    "spec": ("7057FF", "A product spec synthesized from conversation."),
}

# The declaration line uses "difficulty:{level}" / "mode:{mode}" tokens; the
# labels actually created and applied are the flat names above.
LABEL_ALIASES = {
    "difficulty:low": "low-difficulty",
    "difficulty:medium": "medium-difficulty",
    "difficulty:high": "high-difficulty",
    "mode:afk": "afk",
    "mode:hitl": "hitl",
}


def ensure_labels(dry_run: bool) -> list[str]:
    """Create or update the canonical labels. Returns warning lines, if any."""
    if dry_run:
        return [
            "  DRY   would ensure 6 canonical labels exist "
            "(low/medium/high-difficulty, afk, hitl, spec)"
        ]

    warnings = []
    for name, (color, description) in CANONICAL_LABELS.items():
        result = subprocess.run(
            [
                "gh", "label", "create", name,
                "--color", color,
                "--description", description,
                "--force",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            warnings.append(
                f"  WARN  could not ensure label '{name}': "
                f"{(result.stderr or result.stdout).strip()}"
            )
    return warnings


def parse_issue_file(path: Path) -> tuple[str, str]:
    """Split a draft file into (title, rest). Title = first '# ' header."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    title = None
    rest_start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            rest_start = i + 1
        break
    if title is None:
        title = path.stem
    rest = "\n".join(lines[rest_start:])
    return title, rest


def extract_labels(rest: str) -> tuple[list[str], str]:
    """Pull the label declaration line out of the body.

    Accepts either "> difficulty:..., mode:..." (two labels) or "> spec"
    (one label). Returns (labels, remaining_body). labels is empty if the
    line is missing or malformed.
    """
    lines = rest.splitlines()
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines):
        m = LABEL_LINE_PATTERN.match(lines[idx])
        if m:
            labels = [
                LABEL_ALIASES[m.group(1).lower()],
                LABEL_ALIASES[m.group(2).lower()],
            ]
            remaining = "\n".join(lines[idx + 1:]).strip()
            return labels, remaining
        if SPEC_LABEL_LINE_PATTERN.match(lines[idx]):
            remaining = "\n".join(lines[idx + 1:]).strip()
            return ["spec"], remaining
    return [], rest.strip()


def resolve_references(body: str, resolved: dict[str, str]) -> tuple[str, list[str]]:
    """Replace {session-id}/{i} tokens with real issue numbers where known.

    Returns the rewritten body and any tokens that could not be resolved
    (e.g. a forward reference to a draft not yet published in this run).
    """
    unresolved: list[str] = []

    def _sub(match: re.Match) -> str:
        key = f"{match.group(1)}/{match.group(2)}"
        if key in resolved:
            return f"#{resolved[key]}"
        unresolved.append(key)
        return match.group(0)

    return REF_PATTERN.sub(_sub, body), unresolved


def gather_batch_dirs() -> list[Path]:
    """List batch directories under the gateway dir, sorted by name."""
    if not GATEWAY_DIR.is_dir():
        return []
    return sorted(
        d for d in GATEWAY_DIR.iterdir()
        if d.is_dir() and SESSION_ID_PATTERN.match(d.name)
    )


def gather_draft_files(batch_dir: Path) -> list[Path]:
    """List draft files in a batch, in stable, dependency-safe order."""
    ordered = []
    for path in batch_dir.glob("*.md"):
        m = FILENAME_PATTERN.match(path.name)
        if not m:
            continue  # e.g. stray files, not drafts
        ordered.append((int(m.group(1)), path))
    ordered.sort(key=lambda t: t[0])
    return [p for _, p in ordered]


def load_resolved(batch_dir: Path) -> dict[str, str]:
    """Rebuild {session-id}/{i} -> real number from already-published files.

    This is what makes resolution survive across separate hook invocations:
    a rerun after a partial failure sees earlier successes in this batch as
    already resolved, instead of starting from an empty map.
    """
    resolved: dict[str, str] = {}
    published_dir = batch_dir / ".published"
    if not published_dir.is_dir():
        return resolved
    for path in published_dir.glob("issue-*.md"):
        m = PUBLISHED_FILENAME_PATTERN.match(path.name)
        if m:
            resolved[f"{batch_dir.name}/{m.group(1)}"] = m.group(2)
    return resolved


def gh_create_issue(title: str, body: str, labels: list[str]) -> tuple[bool, str]:
    """Create one issue with gh. Body always goes through --body-file."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".md", delete=False, encoding="utf-8"
    ) as tmp:
        tmp.write(body)
        tmp_path = tmp.name

    args = ["gh", "issue", "create", "--title", title, "--body-file", tmp_path]
    for label in labels:
        args += ["--label", label]

    try:
        result = subprocess.run(args, capture_output=True, text=True)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "unknown gh error").strip()

    stdout = result.stdout.strip()
    url = stdout.splitlines()[-1] if stdout else ""
    return True, url


def publish_batch(batch_dir: Path, dry_run: bool, report: list[str]) -> tuple[int, int]:
    """Publish (or dry-run) every draft file in one batch directory.

    Returns (published_count, failed_count) for this batch.
    """
    files = gather_draft_files(batch_dir)
    if not files:
        return 0, 0

    published_dir = batch_dir / ".published"
    if not dry_run:
        published_dir.mkdir(exist_ok=True)

    resolved = load_resolved(batch_dir)
    report.append(f"Batch {batch_dir.name}: {len(files)} draft(s), "
                   f"{len(resolved)} already published in earlier run(s)\n")

    # Worklist retry: a file with an unresolved reference goes back on the
    # queue instead of being skipped permanently, so ordering mistakes
    # (e.g. a diamond dependency numbered out of order) self-heal within
    # this run. Bounded to len(files) passes - a true cycle or a reference
    # to something outside the batch will still be unresolved after that
    # many attempts and gets reported as a real failure.
    pending = files
    published = 0
    failed_entries: list[str] = []

    for _ in range(max(len(files), 1)):
        if not pending:
            break
        still_pending = []
        made_progress = False

        for path in pending:
            title, rest = parse_issue_file(path)
            labels, body_with_refs = extract_labels(rest)

            if not labels or (labels != ["spec"] and len(labels) != 2):
                failed_entries.append(
                    f"  SKIP  {path.name} - missing or malformed label line "
                    f"(expected '> difficulty:{{low|medium|high}}, mode:{{afk|hitl}}' "
                    f"or '> spec')"
                )
                made_progress = True  # not retryable, don't requeue
                continue

            body, unresolved = resolve_references(body_with_refs, resolved)
            if unresolved:
                still_pending.append(path)
                continue

            m = FILENAME_PATTERN.match(path.name)
            i = m.group(1)
            key = f"{batch_dir.name}/{i}"

            if dry_run:
                report.append(
                    f"  DRY   {path.name} -> would create \"{title}\" "
                    f"[{', '.join(labels)}], body {len(body)} chars"
                )
                # Fabricate a placeholder so later dry-run references in
                # this batch resolve too, for a fuller preview.
                resolved[key] = f"NEW-{i}"
                published += 1
                made_progress = True
                continue

            ok, info = gh_create_issue(title, body, labels)
            if ok:
                number_match = re.search(r"/issues/(\d+)", info)
                resolved_number = number_match.group(1) if number_match else "?"
                resolved[key] = resolved_number
                report.append(f"  OK    {path.name} [{', '.join(labels)}] -> {info}")
                path.rename(published_dir / f"issue-{i}-#{resolved_number}.md")
                published += 1
            else:
                failed_entries.append(f"  FAIL  {path.name}: {info}")
            made_progress = True

        pending = still_pending
        if not made_progress:
            break

    # Anything still pending after the retry loop is a genuine problem:
    # either a reference outside this batch, or a real dependency cycle.
    for path in pending:
        title, rest = parse_issue_file(path)
        _, body_with_refs = extract_labels(rest)
        _, unresolved = resolve_references(body_with_refs, resolved)
        failed_entries.append(
            f"  SKIP  {path.name} - unresolved reference(s) after retries: "
            f"{', '.join(unresolved)} (referenced draft not published, "
            f"outside this batch, or part of a cycle)"
        )

    report.extend(failed_entries)
    return published, len(failed_entries)


def publish_issues(dry_run: bool) -> str:
    if not GATEWAY_DIR.is_dir():
        return "No .issues-gateway/ folder found. Run /draft-issue or /draft-issues first."

    batch_dirs = gather_batch_dirs()
    if not batch_dirs:
        return "No draft batches found in .issues-gateway/. Nothing to publish."

    header = "Dry run - no issues will be created" if dry_run else "Publishing drafted issues"
    report = [f"{header} from {GATEWAY_DIR}/\n"]
    report.extend(ensure_labels(dry_run))
    report.append("")

    total_published = 0
    total_failed = 0
    for batch_dir in batch_dirs:
        p, f = publish_batch(batch_dir, dry_run, report)
        total_published += p
        total_failed += f
        report.append("")

    if dry_run:
        report.append(
            f"Dry run complete: {total_published} would publish, "
            f"{total_failed} would be skipped or need attention. "
            f"Nothing was created or moved."
        )
    elif total_failed:
        report.append(
            f"{total_published} issue(s) published. {total_failed} failed or "
            f"were skipped - those files were left in place so you can fix "
            f"and re-run /publish-issues. Already-published issues in this "
            f"batch will not be re-created on rerun."
        )
    else:
        report.append(f"All {total_published} issue(s) published successfully.")

    return "\n".join(report)


def main() -> None:
    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "").strip()

    if PROMPT_PATTERN.match(prompt):
        dry_run = "--dry" in prompt.split()
        result = publish_issues(dry_run)
        sys.stderr.write(result + "\n")
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()