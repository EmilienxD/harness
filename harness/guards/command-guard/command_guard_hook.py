#!/usr/bin/env python3
"""Deny shell commands matched by the command-guard policy file."""

from __future__ import annotations

import json
import os
import re
import sys
import tomllib
from pathlib import Path


CONFIG_NAME = "command-guard.toml"


def _config_sources(root: Path) -> list[Path]:
    """Bundled defaults, then shared user and project configuration."""
    candidates = [
        Path(__file__).with_name(CONFIG_NAME),
        Path.home() / ".harness" / "guards" / CONFIG_NAME,
        root / ".harness" / "guards" / CONFIG_NAME,
    ]
    sources: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        key = candidate.resolve()
        if key not in seen and candidate.is_file():
            seen.add(key)
            sources.append(candidate)
    return sources


POSIX_CLASSES = {
    "[:space:]": r"\s",
}


def _python_pattern(pattern: str) -> str:
    for posix, python in POSIX_CLASSES.items():
        pattern = pattern.replace(posix, python)
    return pattern


def _rules(root: Path) -> list[tuple[re.Pattern[str], str]]:
    rules: list[tuple[re.Pattern[str], str]] = []
    sources = _config_sources(root)
    if not sources:
        raise ValueError("command-guard configuration is missing")
    for source in sources:
        data = tomllib.loads(source.read_text(encoding="utf-8-sig"))
        if data.get("version") != 1 or set(data) != {"version", "rules"}:
            raise ValueError("invalid command-guard configuration")
        entries = data["rules"]
        if not isinstance(entries, list) or not entries:
            raise ValueError("command-guard requires rules")
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"reason", "patterns"}:
                raise ValueError("invalid command-guard rule")
            reason, patterns = entry["reason"], entry["patterns"]
            if not isinstance(reason, str) or not reason.strip():
                raise ValueError("invalid command-guard reason")
            if not isinstance(patterns, list) or not patterns or not all(isinstance(p, str) and p for p in patterns):
                raise ValueError("invalid command-guard patterns")
            rules.extend((re.compile(_python_pattern(pattern), re.IGNORECASE), reason.strip()) for pattern in patterns)
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
        configured_root = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd")
        root = Path(configured_root).resolve() if isinstance(configured_root, str) and configured_root else Path.cwd().resolve()
        rules = _rules(root)
    except (OSError, UnicodeError, re.error, tomllib.TOMLDecodeError, ValueError, KeyError):
        _deny(
            "Command blocked because the command-guard policy could not be "
            "loaded safely. Repair or restore command-guard.toml."
        )
        return 0

    for pattern, reason in rules:
        if pattern.search(command):
            _deny(f"Command blocked by command-guard policy: {reason}.")
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
