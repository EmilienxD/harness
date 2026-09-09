#!/usr/bin/env python3
"""Guard and preload commit metadata for an issue-review invocation.

Blocks before model invocation when the worktree is dirty, and injects the
`HEAD` commit's identity, subject, and changed-file list. The diff is left
for the reviewing agent to read itself.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


INVOCATION = re.compile(
    r"(?:[/$]issue-review|\[\$issue-review\]\([^\r\n]+\))(?=$|\s)"
)
STATUS_NAMES = {
    "A": "added", "M": "modified", "D": "deleted",
    "R": "renamed", "C": "copied", "T": "type changed",
}


class Blocked(Exception):
    """A prerequisite failed; the prompt must not reach the model."""


def git(arguments: list[str], cwd: Path) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=cwd, capture_output=True, text=True,
        encoding="utf-8", timeout=30,
    )
    if result.returncode != 0:
        raise Blocked(
            "issue-review requires a Git repository with at least one commit: "
            f"`git {' '.join(arguments)}` failed. {result.stderr.strip()}"
        )
    return result.stdout


def require_clean_worktree(cwd: Path) -> None:
    """Staged, unstaged, and untracked changes all block; ignored files do not."""
    entries = [
        line for line in
        git(["status", "--porcelain", "--untracked-files=all"], cwd).splitlines()
        if line.strip()
    ]
    if entries:
        listed = "\n".join(entries[:20])
        more = "" if len(entries) <= 20 else f"\n… and {len(entries) - 20} more."
        raise Blocked(
            "issue-review requires a completely clean Git worktree, but the "
            "checkout has staged, unstaged, or untracked changes:\n"
            f"{listed}{more}\nCommit, discard, or set them aside, then invoke "
            "issue-review again."
        )


def parent_sha(cwd: Path) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", "HEAD^"],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    sha = result.stdout.strip()
    return sha if result.returncode == 0 and sha else None


def changed_files(cwd: Path) -> list[str]:
    """Name and status for every path the commit touched, renames included."""
    raw = git(["show", "--name-status", "--find-renames", "--format=", "-z", "HEAD"], cwd)
    fields = [field for field in raw.split("\0") if field]
    entries: list[str] = []
    index = 0
    while index < len(fields):
        code = fields[index]
        letter = code[0]
        name = STATUS_NAMES.get(letter, code)
        if letter in {"R", "C"} and index + 2 < len(fields):
            entries.append(f"{name}: {fields[index + 1]} -> {fields[index + 2]}")
            index += 3
            continue
        if index + 1 < len(fields):
            entries.append(f"{name}: {fields[index + 1]}")
        index += 2
    return entries


def build_context(cwd: Path) -> str:
    require_clean_worktree(cwd)
    head = git(["rev-parse", "HEAD"], cwd).strip()
    subject = git(["log", "-1", "--format=%s", "HEAD"], cwd).strip()
    parent = parent_sha(cwd)
    files = changed_files(cwd)
    lines = [
        "Issue-review context, prepared by a hook from the local repository.",
        "",
        "Worktree verified clean by the issue-review hook before this "
        "invocation; every change now present is yours.",
        "",
        f"- Starting HEAD: {head}",
        f"- Parent commit: {parent}" if parent else "- Parent commit: none (root commit)",
        f"- Subject: {subject}",
        "",
        "## Files changed by the commit under review",
        "",
    ]
    lines.extend(
        [f"- {entry}" for entry in files] if files
        else ["- none (the commit changed no files)"]
    )
    lines.extend([
        "",
        "The diff is deliberately not included; read it yourself from the "
        "repository at the commit above.",
    ])
    return "\n".join(lines)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return
    if not isinstance(payload, dict):
        return
    if payload.get("hook_event_name", "UserPromptSubmit") != "UserPromptSubmit":
        return
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or INVOCATION.match(prompt.strip()) is None:
        return
    cwd = Path(str(payload.get("cwd") or "."))
    try:
        context = build_context(cwd)
    except Blocked as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
    except subprocess.TimeoutExpired:
        print("issue-review timed out reading the repository.", file=sys.stderr)
        raise SystemExit(2)
    json.dump(
        {"hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit", "additionalContext": context,
        }},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
