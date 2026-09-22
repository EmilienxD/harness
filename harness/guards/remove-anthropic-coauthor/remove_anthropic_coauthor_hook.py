#!/usr/bin/env python3
"""Remove Claude's Anthropic co-author trailer from a just-created HEAD commit.

Use Git plumbing for the amend so the index and worktree remain untouched and
the ref update fails atomically if another process has moved HEAD meanwhile.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys


TRAILER = re.compile(
    r"^[ \t]*Co-Authored-By:[ \t]*Claude(?:[ \t]+[^<>\r\n]+)?"
    r"[ \t]*<noreply@anthropic\.com>[ \t]*$", re.IGNORECASE,
)
COMMIT_SUMMARY = re.compile(r"^\[[^\]\r\n]+ ([0-9a-f]{7,64})\] ", re.MULTILINE)
PATH_ARGUMENT = re.compile(
    r"(?:\bcd\s+(?:/d\s+)?|\bgit\s+-C\s+)(\"[^\"]+\"|'[^']+'|[^\s;&|]+)",
    re.IGNORECASE,
)


def git(repo: Path, *args: str, message: str | None = None,
        env: dict[str, str] | None = None) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        input=message.encode("utf-8") if message is not None else None,
        capture_output=True, check=True, timeout=15, env=env,
    ).stdout.decode("utf-8")


def clean_message(message: str) -> str:
    # Restrict removal to the final trailer paragraph; quoted examples in the
    # body and human co-authors are not attribution to remove.
    lines = message.rstrip("\n").split("\n")
    start = len(lines) - 1
    while start >= 0 and lines[start].strip():
        start -= 1
    tail = lines[start + 1:]
    if not all(re.fullmatch(r"[A-Za-z0-9-]+:[ \t]+.+", line) for line in tail):
        return message
    if not any(TRAILER.fullmatch(line) for line in tail):
        return message
    kept = lines[:start + 1] + [line for line in tail if not TRAILER.fullmatch(line)]
    return "\n".join(kept).rstrip("\n") + "\n"


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except (ValueError, TypeError):
        return 0
    try:
        if not isinstance(data, dict) or data.get("tool_name") not in {"Bash", "PowerShell"}:
            return 0
        if data.get("hook_event_name") != "PostToolUse":
            return 0
        tool_input = data.get("tool_input")
        response = data.get("tool_response")
        if not isinstance(tool_input, dict) or not isinstance(response, dict):
            return 0
        command = tool_input.get("command")
        stdout = response.get("stdout")
        if not isinstance(command, str) or not isinstance(stdout, str):
            return 0
        if response.get("interrupted") or response.get("exit_code", 0) != 0:
            return 0
        if not re.search(r"\bgit\b[^\n]*\bcommit\b", command):
            return 0
        summaries = COMMIT_SUMMARY.findall(stdout)
        if not summaries or not isinstance(data.get("cwd"), str):
            return 0
        cwd = Path(data["cwd"])
        candidates = [cwd]
        for match in PATH_ARGUMENT.finditer(command):
            path = Path(match[1].strip("\"'"))
            cwd = path if path.is_absolute() else cwd / path
            candidates.append(cwd)
        matches = {}
        for candidate in candidates:
            try:
                head = git(candidate, "rev-parse", "HEAD").strip()
                root = git(candidate, "rev-parse", "--absolute-git-dir").strip()
            except (OSError, subprocess.SubprocessError):
                continue
            if head.startswith(summaries[-1]):
                matches[root] = (candidate, head)
        if len(matches) != 1:
            return 0
        repo, head = next(iter(matches.values()))
        message = git(repo, "show", "-s", "--format=%B", head)
        cleaned = clean_message(message)
        if cleaned == message:
            return 0
        metadata = git(repo, "show", "-s", "--format=%T%n%P%n%an%n%ae%n%aI", head).splitlines()
        tree, parents, name, email, date = metadata
        env = dict(os.environ, GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email, GIT_AUTHOR_DATE=date)
        args = ["commit-tree", tree]
        for parent in parents.split():
            args.extend(["-p", parent])
        signing = subprocess.run(
            ["git", "-C", str(repo), "config", "--bool", "commit.gpgSign"],
            capture_output=True, text=True, timeout=15,
        )
        if signing.stdout.strip() == "true":
            args.append("-S")
        amended = git(repo, *args, message=cleaned, env=env).strip()
        subject = cleaned.splitlines()[0] if cleaned.strip() else ""
        git(repo, "update-ref", "-m", "commit (amend): " + subject,
            "HEAD", amended, head)
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": f"Removed Claude's Anthropic co-author trailer. Commit {head} was amended to {amended}; use the new hash.",
        }}))
        return 0
    except (ValueError, TypeError, OSError, subprocess.SubprocessError) as exc:
        print(f"remove-anthropic-coauthor: could not clean commit: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
