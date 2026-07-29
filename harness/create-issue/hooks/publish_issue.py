#!/usr/bin/env python3
"""UserPromptSubmit hook: publishes drafted single GitHub issues from .issue-gateway/.

Fires before Claude ever sees the prompt. When the prompt is "/publish-issue"
(optionally "/publish-issue --dry-run"), this script does all the work itself
with `gh` and exits 2, which erases the prompt and shows stderr to the user
only - zero API calls for this step.

This is the singular sibling of the create-issues tool's publish_issues.py:
one draft per file, no intra-batch dependencies, so there is deliberately no
reference resolution and no retry loop here.

Design notes:
- Drafts are flat files: ".issue-gateway/{session-id}.md", one per drafting
  session, where the session id is the Claude Code session id the drafting run
  had (${CLAUDE_SESSION_ID}). Only filenames shaped like a session id are
  considered drafts, so a stray note dropped in the folder is never published.
- The first "# " header line in a draft file is the issue title. The first
  non-empty line after that must be "> difficulty:{low|medium|high}, mode:{afk|hitl}"
  (see /draft-issue) - it is parsed and mapped to the flat label names
  ("low-difficulty", "medium-difficulty", "high-difficulty", "afk", "hitl")
  via LABEL_ALIASES, then stripped from the body that gets posted, since the
  labels carry that information from then on.
- Once an issue is published, its file is moved into ".published/" and renamed
  to encode the real issue number ("{session-id}-#{number}.md"), so a rerun
  after a partial failure never re-creates an issue that already exists.
- "Blocked by" sections in drafts reference existing tracker issues by their
  real numbers ("#42"); there are no sibling drafts to link to, so nothing
  needs rewriting at publish time.
- The body is always passed to `gh` via --body-file (a temp file), never
  inline on the command line. This is what avoids the Windows command-line
  length limit, on every platform, regardless of body size.
- "--dry-run" runs the exact same parse logic but never calls
  `gh issue create` and never moves/renames files - it reports what would
  happen, so a bad label line can be caught before anything touches the
  tracker.
- Prompt matching is exact: "/publish-issue" followed by end of string or
  whitespace. "startswith" would also match "/publish-issues" (the batch
  tool's skill), which must stay reachable when both tools are installed.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

GATEWAY_DIR = Path(".issue-gateway")

# "/publish-issue" and "/publish-issue --dry-run" match; "/publish-issues"
# (the sibling batch tool) must not.
PROMPT_PATTERN = re.compile(r"^/publish-issue(?:\s|$)")

# A draft filename: a Claude Code session id (a UUID), ".md" suffix.
SESSION_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.md$"
)

# The label declaration line produced by /draft-issue, e.g.
# "> difficulty:medium, mode:hitl". Tolerant of leading whitespace before
# the ">" and of surrounding spaces around the comma.
LABEL_LINE_PATTERN = re.compile(
    r"^\s*>\s*(difficulty:(?:low|medium|high))\s*,\s*(mode:(?:afk|hitl))\s*$",
    re.IGNORECASE,
)

# Canonical labels this workflow depends on: (color, description). Created
# (or updated) with --force at the start of every publish run, so they
# always exist regardless of repo state.
CANONICAL_LABELS = {
    "low-difficulty": ("0E8A16", "Routine, well-understood work - safe for a lighter model."),
    "medium-difficulty": ("FBCA04", "Multi-step work with real design decisions."),
    "high-difficulty": ("D93F0B", "Needs careful judgment, wide context, or unusual reasoning."),
    "afk": ("1D76DB", "Safe to implement in one shot, no review needed before landing."),
    "hitl": ("5319E7", "Sensitive, design-touching, or complex - needs human review."),
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
            "  DRY   would ensure 5 canonical labels exist "
            "(low/medium/high-difficulty, afk, hitl)"
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
    """Pull the '> difficulty:..., mode:...' line out of the body.

    Returns (labels, remaining_body). labels is empty if the line is
    missing or malformed.
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
    return [], rest.strip()


def gather_draft_files() -> list[Path]:
    """List draft files in the gateway dir, sorted by name."""
    if not GATEWAY_DIR.is_dir():
        return []
    return sorted(
        p for p in GATEWAY_DIR.glob("*.md")
        if SESSION_ID_PATTERN.match(p.name)
    )


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


def publish_draft(path: Path, published_dir: Path, dry_run: bool, report: list[str]) -> int:
    """Publish (or dry-run) one draft file. Returns 0 on success, 1 on skip/failure."""
    title, rest = parse_issue_file(path)
    labels, body = extract_labels(rest)

    if len(labels) != 2:
        report.append(
            f"  SKIP  {path.name} - missing or malformed "
            f"'> difficulty:{{low|medium|high}}, mode:{{afk|hitl}}' line"
        )
        return 1

    if dry_run:
        report.append(
            f"  DRY   {path.name} -> would create \"{title}\" "
            f"[{', '.join(labels)}], body {len(body)} chars"
        )
        return 0

    ok, info = gh_create_issue(title, body, labels)
    if ok:
        number_match = re.search(r"/issues/(\d+)", info)
        resolved_number = number_match.group(1) if number_match else "?"
        report.append(f"  OK    {path.name} [{', '.join(labels)}] -> {info}")
        path.rename(published_dir / f"{path.stem}-#{resolved_number}.md")
        return 0

    report.append(f"  FAIL  {path.name}: {info}")
    return 1


def publish_drafts(dry_run: bool) -> str:
    if not GATEWAY_DIR.is_dir():
        return "No .issue-gateway/ folder found. Run /draft-issue first."

    files = gather_draft_files()
    if not files:
        return "No drafts found in .issue-gateway/. Nothing to publish."

    header = "Dry run - no issues will be created" if dry_run else "Publishing drafted issues"
    report = [f"{header} from {GATEWAY_DIR}/\n"]
    report.extend(ensure_labels(dry_run))
    report.append("")

    published_dir = GATEWAY_DIR / ".published"
    if not dry_run:
        published_dir.mkdir(exist_ok=True)

    published = 0
    failed = 0
    for path in files:
        if publish_draft(path, published_dir, dry_run, report) == 0:
            published += 1
        else:
            failed += 1
    report.append("")

    if dry_run:
        report.append(
            f"Dry run complete: {published} would publish, "
            f"{failed} would be skipped. Nothing was created or moved."
        )
    elif failed:
        report.append(
            f"{published} issue(s) published. {failed} failed or were "
            f"skipped - those files were left in place so you can fix "
            f"and re-run /publish-issue. Already-published issues will "
            f"not be re-created on rerun."
        )
    else:
        report.append(f"All {published} issue(s) published successfully.")

    return "\n".join(report)


def main() -> None:
    payload = json.load(sys.stdin)
    prompt = payload.get("prompt", "").strip()

    if PROMPT_PATTERN.match(prompt):
        dry_run = "--dry-run" in prompt.split()
        result = publish_drafts(dry_run)
        sys.stderr.write(result + "\n")
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
