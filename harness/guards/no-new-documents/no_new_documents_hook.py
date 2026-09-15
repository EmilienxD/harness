#!/usr/bin/env python3
"""Deny agent attempts to create files in configured documentation paths."""

from __future__ import annotations

import json
import os
import re
import sys
import tomllib
from pathlib import Path
from typing import Any


CONFIG_NAME = "no-new-documents.toml"


def _config_sources(root: Path) -> list[Path]:
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


ADD_FILE = re.compile(r"^\*\*\* Add File: (.+)$", re.MULTILINE)
REDIRECTION = re.compile(
    r"(?:^|\s)(?:\d?>{1,2})\s*(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))"
)
POWERSHELL_NEW_FILE = re.compile(
    r"\bNew-Item\b(?=[^;&|]*-ItemType\s+File\b)[^;&|]*"
    r"-(?:LiteralPath|Path)\s+(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))",
    re.IGNORECASE,
)
BASH_TOUCH = re.compile(
    r"(?:^|[;&|]\s*)touch\s+(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))\s*(?:$|[;&|])"
)
POWERSHELL_CONTENT = re.compile(
    r"\b(?:Set-Content|Add-Content)\b[^;&|]*?-(?:LiteralPath|Path)\s+"
    r"(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))",
    re.IGNORECASE,
)
POWERSHELL_OUT_FILE = re.compile(
    r"\bOut-File\b[^;&|]*?-FilePath\s+(?:\"([^\"]+)\"|'([^']+)'|([^\s;&|]+))",
    re.IGNORECASE,
)
CWD_CHANGE = re.compile(r"(?:^|[;&|]\s*)(?:cd|chdir|Set-Location|Push-Location)\b", re.IGNORECASE)


def _configuration(root: Path) -> tuple[re.Pattern[str], ...]:
    compiled: list[re.Pattern[str]] = []
    sources = _config_sources(root)
    if not sources:
        raise ValueError("no-new-documents configuration is missing")
    for source in sources:
        data = tomllib.loads(source.read_text(encoding="utf-8"))
        raw_patterns = data.get("protected")
        if data.get("version") != 1 or set(data) != {"version", "protected"}:
            raise ValueError("invalid no-new-documents configuration")
        if not isinstance(raw_patterns, list) or not raw_patterns:
            raise ValueError("protected must be a non-empty array")
        source_patterns = tuple(_compile_pattern(item) for item in raw_patterns if isinstance(item, str))
        if len(source_patterns) != len(raw_patterns) or any(item is None for item in source_patterns):
            raise ValueError("invalid protected pattern")
        compiled.extend(item for item in source_patterns if item is not None)
    return tuple(compiled)


def _root(payload: dict[str, Any]) -> Path:
    project = os.environ.get("CLAUDE_PROJECT_DIR")
    if project:
        return Path(project).resolve()
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd:
        return Path(cwd).resolve()
    return Path.cwd().resolve()


def _relative_parts(path_text: str, root: Path) -> tuple[str, ...] | None:
    candidate = Path(path_text)
    try:
        resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
        relative = resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    return tuple(relative.parts)


def _compile_pattern(pattern: str) -> re.Pattern[str] | None:
    pattern = pattern.strip().replace("\\", "/")
    if not pattern or pattern.startswith("/") or ".." in pattern.split("/"):
        return None
    anchored = "/" in pattern and not pattern.startswith("**/")
    directory = pattern.endswith("/")
    pattern = pattern.rstrip("/") if directory else pattern
    out: list[str] = []
    i = 0
    while i < len(pattern):
        if pattern[i:i + 2] == "**":
            if i + 2 < len(pattern) and pattern[i + 2] == "/":
                out.append("(?:[^/]+/)*")
                i += 3
            else:
                out.append(".*")
                i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    body = "".join(out) + ("(?:/.*)?" if directory else "")
    return re.compile(("^" if anchored else "^(?:[^/]+/)*") + body + "$")


def _is_protected(parts: tuple[str, ...], patterns: tuple[re.Pattern[str], ...]) -> bool:
    path = "/".join(parts)
    return any(pattern.match(path) for pattern in patterns)


def _literal_path(groups: tuple[str | None, ...]) -> str | None:
    value = next((item for item in groups if item), None)
    if value is None or any(marker in value for marker in ("$", "%", "*", "?", "`")):
        return None
    return value


def _shell_candidates(command: str) -> list[str]:
    """Return only output paths whose creation intent is syntactically clear.

    Commands that change directory or use variables/globs are deliberately
    ignored: missing a clever creation is preferable to blocking an unrelated
    command based on a guessed path.
    """
    if CWD_CHANGE.search(command):
        return []
    candidates = [
        path
        for match in REDIRECTION.finditer(command)
        if (path := _literal_path(match.groups())) is not None
    ]
    for pattern in (BASH_TOUCH, POWERSHELL_NEW_FILE, POWERSHELL_CONTENT, POWERSHELL_OUT_FILE):
        candidates.extend(
            path
            for match in pattern.finditer(command)
            if (path := _literal_path(match.groups())) is not None
        )
    return candidates


def _deny(path: str) -> None:
    reason = (
        f"Creating the new document `{path}` is not authorized. You may modify existing "
        "documents, but do not create this file through another tool or at another path. "
        "Continue any other work. In your final response, ask the user whether they want "
        "this document added and explain why you wanted to add it."
    )
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
    tool_name = payload.get("tool_name")
    candidates: list[str] = []
    if tool_name == "Write":
        file_path = tool_input.get("file_path")
        if isinstance(file_path, str) and file_path:
            candidates.append(file_path)
    elif tool_name == "apply_patch":
        command = tool_input.get("command") or tool_input.get("patch")
        if isinstance(command, str):
            candidates.extend(match.group(1).strip() for match in ADD_FILE.finditer(command))
    elif tool_name in {"Bash", "PowerShell"}:
        command = tool_input.get("command")
        if isinstance(command, str):
            candidates.extend(_shell_candidates(command))
    if not candidates:
        return 0
    root = _root(payload)
    try:
        patterns = _configuration(root)
    except (OSError, UnicodeError, tomllib.TOMLDecodeError, ValueError):
        return 0
    for file_path in candidates:
        parts = _relative_parts(file_path, root)
        if parts is None:
            continue
        candidate = Path(file_path) if Path(file_path).is_absolute() else root / file_path
        if not candidate.exists() and _is_protected(parts, patterns):
            _deny("/".join(parts))
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
