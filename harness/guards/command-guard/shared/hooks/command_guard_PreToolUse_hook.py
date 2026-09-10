#!/usr/bin/env python3
"""Deny shell commands matched by the adjacent command-guard policy file."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


POLICY_PATH = Path(__file__).with_name("command-guard.rules")
POSIX_CLASSES = {
    "[:space:]": r"\s",
}


def _python_pattern(pattern: str) -> str:
    for posix, python in POSIX_CLASSES.items():
        pattern = pattern.replace(posix, python)
    return pattern


def _rules() -> list[tuple[re.Pattern[str], str]]:
    rules: list[tuple[re.Pattern[str], str]] = []
    reason = "a configured dangerous-command rule"
    for raw_line in POLICY_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("# ") and re.match(r"# \d+[a-z]?\.", line):
            reason = line.split(".", 1)[1].strip()
            continue
        if not line or line.startswith("#"):
            continue
        rules.append((re.compile(_python_pattern(line), re.IGNORECASE), reason))
    return rules


def _deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        return 0

    try:
        rules = _rules()
    except (OSError, UnicodeError, re.error):
        _deny(
            "Command blocked because the command-guard policy could not be "
            "loaded safely. Repair or restore command-guard.rules."
        )
        return 0

    for pattern, reason in rules:
        if pattern.search(command):
            _deny(f"Command blocked by command-guard policy: {reason}.")
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
