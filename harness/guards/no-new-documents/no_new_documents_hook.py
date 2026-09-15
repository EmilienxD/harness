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


def _config_path() -> Path:
    """Find the config in the platform directory, with legacy fallback."""
    installed = Path(__file__).resolve().parent.parent / CONFIG_NAME
    if installed.is_file():
        return installed
    return Path(__file__).with_name(CONFIG_NAME)


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


def _configuration() -> tuple[tuple[tuple[str, ...], ...], int]:
    data = tomllib.loads(_config_path().read_text(encoding="utf-8"))
    raw_paths = data.get("paths")
    max_depth = data.get("max_depth", -1)
    if (
        not isinstance(raw_paths, list)
        or not raw_paths
        or not all(isinstance(item, str) and item.strip() for item in raw_paths)
        or not isinstance(max_depth, int)
        or max_depth < -1
    ):
        raise ValueError("invalid no-new-documents configuration")
    paths: list[tuple[str, ...]] = []
    for item in raw_paths:
        path = Path(item.strip().replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("configured paths must be relative and contained")
        parts = tuple(part for part in path.parts if part not in ("", "."))
        if not parts:
            raise ValueError("configured paths cannot be empty")
        paths.append(parts)
    return tuple(paths), max_depth


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


def _is_protected(parts: tuple[str, ...], paths: tuple[tuple[str, ...], ...], max_depth: int) -> bool:
    comparable = tuple(os.path.normcase(part) for part in parts)
    for configured in paths:
        wanted = tuple(os.path.normcase(part) for part in configured)
        width = len(wanted)
        for start in range(0, len(comparable) - width):
            if comparable[start:start + width] == wanted and (max_depth == -1 or start <= max_depth):
                return True
    return False


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
        paths, max_depth = _configuration()
    except (OSError, UnicodeError, tomllib.TOMLDecodeError, ValueError):
        return 0
    for file_path in candidates:
        parts = _relative_parts(file_path, root)
        if parts is None:
            continue
        candidate = Path(file_path) if Path(file_path).is_absolute() else root / file_path
        if not candidate.exists() and _is_protected(parts, paths, max_depth):
            _deny("/".join(parts))
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
