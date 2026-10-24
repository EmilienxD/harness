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
    personal = Path(os.environ.get("HARNESS_PI_SUPPORT_DIR", Path(__file__).parent)) / CONFIG_NAME
    candidates = [
        personal if personal.is_file() else Path(__file__).with_name(CONFIG_NAME),
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


MALFORMED_POLICY_MESSAGE = (
    "Command blocked because the command-guard policy could not be "
    "loaded safely. Repair or restore command-guard.toml."
)


def denial_reason(command: str, root: Path) -> str | None:
    """Deny message for a command, or None when it is allowed.

    A missing or malformed policy denies every command.
    """
    try:
        rules = _rules(root)
    except (OSError, UnicodeError, re.error, tomllib.TOMLDecodeError, ValueError, KeyError):
        return MALFORMED_POLICY_MESSAGE
    for pattern, reason in rules:
        if pattern.search(command):
            return f"Command blocked by command-guard policy: {reason}."
    return None


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
        check_action()
    except Exception as error:
        _deny(f"Command guard could not check this action ({type(error).__name__}): {error}")
    return 0


def check_action() -> None:
    if callable(getattr(sys.stdin, "reconfigure", None)):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("hook input must be a JSON object")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        raise ValueError("shell action must contain tool_input")
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        raise ValueError("shell action must contain a non-empty command")

    try:
        configured_root = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd")
        root = Path(configured_root).resolve() if isinstance(configured_root, str) and configured_root else Path.cwd().resolve()
    except (OSError, UnicodeError, ValueError):
        _deny(MALFORMED_POLICY_MESSAGE)
        return

    reason = denial_reason(command, root)
    if reason:
        _deny(reason)


if __name__ == "__main__":
    raise SystemExit(main())
