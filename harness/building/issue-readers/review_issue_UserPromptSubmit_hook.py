#!/usr/bin/env python3
"""Guard and preload commit metadata for a review-this invocation.

Blocks dirty manual invocations and injects the pinned target's identity and
changed-file list. Aboard may explicitly supply a dirty HITL review range.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


INVOCATION = re.compile(
    r"(?:[/$]review-this|\[\$review-this\]\([^\r\n]+\))(?=$|\s)"
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
            "review-this requires a Git repository with at least one commit: "
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
            "review-this requires a completely clean Git worktree, but the "
            "checkout has staged, unstaged, or untracked changes:\n"
            f"{listed}{more}\nCommit, discard, or set them aside, then invoke "
            "review-this again."
        )


def parent_sha(cwd: Path) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", "HEAD^"],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    sha = result.stdout.strip()
    return sha if result.returncode == 0 and sha else None


def changed_files(cwd: Path, review_range: str | None = None) -> list[str]:
    """Name and status for every path the commit touched, renames included."""
    arguments = ["show", "--name-status", "--find-renames", "--format=", "-z", "HEAD"] if review_range is None else ["diff", "--name-status", "--find-renames", "-z", review_range]
    raw = git(arguments, cwd)
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
    review_range = os.environ.get("ABOARD_REVIEW_RANGE")
    continuation = os.environ.get("ABOARD_WORKER_CONTINUATION") == "1"
    if review_range is not None and re.fullmatch(r"[0-9a-fA-F]{40,64}\.\.[0-9a-fA-F]{40,64}", review_range) is None:
        raise Blocked("review-this received an invalid pinned review range from Aboard.")
    if review_range is None and not continuation:
        require_clean_worktree(cwd)
    head = git(["rev-parse", "HEAD"], cwd).strip()
    subject = git(["log", "-1", "--format=%s", review_range.split("..", 1)[1] if review_range else "HEAD"], cwd).strip()
    parent = review_range.split("..", 1)[0] if review_range else parent_sha(cwd)
    files = changed_files(cwd, review_range)
    lines = [
        "Review-this context, prepared by a hook from the local repository.",
        "",
        (
            f"Aboard pinned {review_range} as the immutable review scope. Its implementation is intentionally present as uncommitted working-tree changes; do not commit it."
            if review_range is not None
            else "Aboard is continuing the exact reviewer conversation over its preserved working tree. Treat every existing change as part of that continuation."
            if continuation
            else "Worktree verified clean by the review-this hook before this invocation; every change now present is yours."
        ),
        "",
        f"- Starting HEAD: {head}",
        f"- Review range: {review_range}" if review_range else (f"- Parent commit: {parent}" if parent else "- Parent commit: none (root commit)"),
        f"- Subject: {subject}",
        "",
        "## Files changed by the pinned implementation" if review_range else "## Files changed by the commit under review",
        "",
    ]
    lines.extend(
        [f"- {entry}" for entry in files] if files
        else ["- none (the commit changed no files)"]
    )
    lines.extend([
        "",
        "The diff is deliberately not included; read the pinned target or "
        "range yourself from the repository.",
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
        print("review-this timed out reading the repository.", file=sys.stderr)
        raise SystemExit(2)
    json.dump(
        {"hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit", "additionalContext": context,
        }},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
