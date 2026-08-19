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
  /to-spec-draft-issue): either "> spec", or
  "> " followed by a comma-separated list of label tokens in any order -
  "difficulty:{level}" and "mode:{afk|hitl}" are each optional (the user can
  ask for them to be left off), and extra labels the user asked for may be
  added alongside (e.g. "> ci, difficulty:advanced"). Aliased tokens map to the
  workflow's own "[AI]-" prefixed label names ("[AI]-advanced-difficulty", "[AI]-afk",
  "[AI]-spec", ...) via LABEL_ALIASES, then are stripped from the body that
  gets posted, since the labels carry that information from then on. Extra
  (non-aliased) tokens pass through as-is - the drafting skills are
  responsible for checking with `gh label list` that they exist.
- A reference to another draft issue, written as "{session-id}/{i}" in the body, is
  rewritten to "#<real-issue-number>" once that draft has been published.
  This is how "blocked by" links get resolved without creating issues
  sequentially inside the agent loop.
- Once an issue is published, its draft file is deleted immediately. If a
  later draft cannot publish in the same run, any references that are already
  known are rewritten in that remaining draft before it is left in place, so
  a rerun does not need an archive of successful drafts to resolve them.
- Within a single run, unresolved references are retried in a worklist loop
  rather than skipped once and left for a manual rerun - this self-heals
  ordering mistakes (e.g. a diamond dependency the model numbered wrong)
  and only reports a failure for references that are still unresolved after
  every file that *could* make progress has been tried.
- The body is always passed to `gh` via --body-file (a temp file), never
  inline on the command line. This is what avoids the Windows command-line
  length limit, on every platform, regardless of body size.
- "--dry" runs the exact same parse/resolve logic but never calls
  `gh issue create` and never deletes files - it reports what would
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

# The label declaration line produced by /draft-issues or /draft-issue: a
# comma-separated list of label tokens in any order, with "difficulty:*" and
# "mode:*" each optional and extra labels allowed, e.g.
# "> difficulty:advanced, mode:hitl", "> mode:afk", "> ci, difficulty:basic".
# Tolerant of leading whitespace before the ">" and of surrounding spaces
# around tokens and commas.
_LABEL_TOKEN = r"[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?"
LABEL_LINE_PATTERN = re.compile(
    rf"^\s*>(?:\s*{_LABEL_TOKEN}\s*,)*\s*{_LABEL_TOKEN}\s*$",
    re.IGNORECASE,
)

# The label declaration line produced by /to-spec-draft-issue ("> spec").
SPEC_LABEL_LINE_PATTERN = re.compile(r"^\s*>\s*spec\s*$", re.IGNORECASE)

# Canonical labels this workflow depends on: (color, description). They carry
# an "[AI]-" prefix so they can't collide with a repo's own labels, and so the
# same labels can be shared across projects that use this tool as a dependency.
# They are created at the start of every publish run if missing; existing ones
# are left alone, so the user's own styling is never overwritten.
CANONICAL_LABELS = {
    "[AI]-routine-difficulty": ("0E8A16", "Low reasoning level work - use rarely."),
    "[AI]-basic-difficulty": ("FBCA04", "Easy, small refactors, missing tests, or documentation."),
    "[AI]-advanced-difficulty": ("D93F0B", "Multi-step work with expected outcomes and low bug risk."),
    "[AI]-expert-difficulty": ("B60205", "Complex, judgment-heavy, wide-context, or bug-prone work."),
    "[AI]-afk": ("1D76DB", "Safe to implement in one shot, no review needed before landing."),
    "[AI]-hitl": ("5319E7", "Sensitive, design-touching, or complex - needs human review."),
    "[AI]-spec": ("7057FF", "A product spec synthesized from conversation."),
}

# The declaration line uses "difficulty:{level}" / "mode:{mode}" tokens; the
# labels actually created and applied are the names above. Any other token on
# the line is applied as-is (the drafting skills check those exist with
# `gh label list` before writing them).
LABEL_ALIASES = {
    "difficulty:routine": "[AI]-routine-difficulty",
    "difficulty:basic": "[AI]-basic-difficulty",
    "difficulty:advanced": "[AI]-advanced-difficulty",
    "difficulty:expert": "[AI]-expert-difficulty",
    "mode:afk": "[AI]-afk",
    "mode:hitl": "[AI]-hitl",
    "spec": "[AI]-spec",
}


def ensure_labels(dry: bool) -> list[str]:
    """Create the canonical labels that are missing; never touch existing ones.

    "gh label create" exits non-zero with an "already exists" error when the
    label is present, so a plain create is create-only: an existing label's
    color and description are left exactly as the user has them."""
    if dry:
        return []

    warnings = []
    for name, (color, description) in CANONICAL_LABELS.items():
        result = subprocess.run(
            [
                "gh", "label", "create", name,
                "--color", color,
                "--description", description,
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 and "already exists" in (result.stderr or result.stdout):
            continue  # already there - leave it untouched
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

    Accepts either "> spec" (one label) or
    "> " followed by a comma-separated
    list of label tokens in any order - "difficulty:*" and "mode:*" are each
    optional, and extra labels pass through as-is. Returns (labels,
    remaining_body). labels is empty if the line is missing or malformed
    (e.g. a ">" quote, or a list carrying a token that can't be a label -
    the whole line is left in the body untouched rather than silently
    applying a partial set of labels).
    """
    lines = rest.splitlines()
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines):
        if SPEC_LABEL_LINE_PATTERN.match(lines[idx]):
            remaining = "\n".join(lines[idx + 1:]).strip()
            return [LABEL_ALIASES["spec"]], remaining
        if LABEL_LINE_PATTERN.match(lines[idx]):
            content = lines[idx].strip()[1:]  # drop the leading ">"
            labels = []
            for token in content.split(","):
                name = LABEL_ALIASES.get(token.strip().lower(), token.strip())
                if name not in labels:
                    labels.append(name)
            if labels:
                remaining = "\n".join(lines[idx + 1:]).strip()
                return labels, remaining
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


def rewrite_known_references(path: Path, resolved: dict[str, str]) -> None:
    """Persist any known reference rewrites in a draft that remains pending."""
    if not resolved:
        return

    text = path.read_text(encoding="utf-8")

    def _sub(match: re.Match) -> str:
        key = f"{match.group(1)}/{match.group(2)}"
        if key in resolved:
            return f"#{resolved[key]}"
        return match.group(0)

    rewritten = REF_PATTERN.sub(_sub, text)
    if rewritten != text:
        path.write_text(rewritten, encoding="utf-8")


def delete_published_draft(path: Path) -> None:
    """Remove a draft after gh confirms the issue exists."""
    path.unlink()


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


def publish_batch(batch_dir: Path, dry: bool, report: list[str]) -> tuple[int, int]:
    """Publish (or dry-run) every draft file in one batch directory.

    Returns (published_count, failed_count) for this batch.
    """
    files = gather_draft_files(batch_dir)
    if not files:
        return 0, 0

    resolved: dict[str, str] = {}
    batch_header = f"Batch: {len(files)} draft issue(s)"
    report.append(batch_header)
    report.append("")

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

            if not labels:
                if not dry:
                    rewrite_known_references(path, resolved)
                failed_entries.append(
                    f"  SKIP  {path.name} - missing or malformed label line"
                )
                made_progress = True  # not retryable, don't requeue
                continue

            body, unresolved = resolve_references(body_with_refs, resolved)
            if unresolved:
                if not dry:
                    rewrite_known_references(path, resolved)
                still_pending.append(path)
                continue

            m = FILENAME_PATTERN.match(path.name)
            if not m:
                continue
            i = m.group(1)
            key = f"{batch_dir.name}/{i}"

            if dry:
                report.append(
                    f"  Would create: \"{title}\" [{', '.join(labels)}]"
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
                report.append(f"  Created: {info}")
                delete_published_draft(path)
                published += 1
            else:
                rewrite_known_references(path, resolved)
                failed_entries.append(f"  FAIL  {path.name}: {info}")
            made_progress = True

        pending = still_pending
        if not made_progress:
            break

    # Anything still pending after the retry loop is a genuine problem:
    # either a reference outside this batch, or a real dependency cycle.
    for path in pending:
        if not dry:
            rewrite_known_references(path, resolved)
        title, rest = parse_issue_file(path)
        _, body_with_refs = extract_labels(rest)
        _, unresolved = resolve_references(body_with_refs, resolved)
        failed_entries.append(
            f"  SKIP  {path.name} - unresolved reference: {', '.join(unresolved)}"
        )

    report.extend(failed_entries)
    return published, len(failed_entries)


def publish_issues(dry: bool) -> str:
    if not GATEWAY_DIR.is_dir():
        return "No .issues-gateway/ folder found. Run /draft-issue or /draft-issues first."

    batch_dirs = gather_batch_dirs()
    if not batch_dirs:
        return "No draft batches found in .issues-gateway/. Nothing to publish."

    header = "Dry run -- nothing will be created" if dry else "Publishing drafted issues"
    report = [header, ""]
    label_warnings = ensure_labels(dry)
    if label_warnings:
        report.extend(label_warnings)
        report.append("")

    total_published = 0
    total_failed = 0
    for batch_dir in batch_dirs:
        p, f = publish_batch(batch_dir, dry, report)
        total_published += p
        total_failed += f
        report.append("")

    if dry:
        report.append(
            f"Dry run complete: {total_published} issue(s) ready to publish."
        )
        if total_failed:
            report.append(f"{total_failed} would be skipped (see above).")
    elif total_failed:
        report.append(
            f"Published {total_published} issue(s). {total_failed} failed or were skipped."
        )
        report.append("Failed drafts remain in .issues-gateway/ -- fix and rerun.")
    else:
        report.append(f"Published {total_published} issue(s) successfully.")

    return "\n".join(report)


def main() -> None:
    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "").strip()

    if PROMPT_PATTERN.match(prompt):
        dry = "--dry" in prompt.split()
        result = publish_issues(dry)
        sys.stderr.write("\n\n" + result)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
