#!/usr/bin/env python3
"""
Claude Code / ChatGPT PostToolUse hook: on-read-reminder.

Fires after a Read call, and after Bash commands that read files through
cat/more/less/head/tail/type. When the path being read matches a
gitignore-style pattern from an `on-read-reminder.toml` file, the hook
reminds the agent -- via additionalContext -- to read the file(s) the rule
maps to (a glossary, conventions doc, ...) before going further.

Its TOML schema is shared with the sibling path guards. User rules load from
`~/.harness/guards/`, then project rules from `.harness/guards/`; later rules
can override earlier ones.

It never blocks: PostToolUse runs after the tool call already happened, so
the hook only adds context and always exits 0.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tomllib
from pathlib import Path
from typing import Any

# Installed beside hooks; the source checkout keeps internal dependencies separate.
_common_source = Path(__file__).resolve().parents[2] / "internal" / "path-guard-common"
if Path(__file__).resolve().parent.parent.name == "guards" and _common_source.is_dir():
    sys.path.insert(0, str(_common_source))
import path_guard_common as common

PROVIDER = "chatgpt" if "--chatgpt" in sys.argv else "claude"

RULES_NAME = "on-read-reminder.toml"



class Rule:
    __slots__ = ("negated", "pattern", "files")

    def __init__(self, negated: bool, pattern: re.Pattern[str], files: tuple[str, ...]) -> None:
        self.negated = negated        # True for `!<pattern>` lines
        self.pattern = pattern        # compiled regex over a project-relative path
        self.files = files            # tuple of reminder files (empty for negations)


def compile_pattern(pattern: str) -> re.Pattern[str] | None:
    """Compile one gitignore-style pattern to a regex, or None if unusable.

    Supported: `*` (within a segment), `?` (one char in a segment), `**`
    (any number of segments), a leading `/` and trailing `/` (directory:
    matches the directory itself and anything under it). A pattern with a
    slash is anchored at the project root; one without matches the basename
    at any depth.
    """
    pattern = pattern.strip().strip("\r")
    if pattern.startswith("/"):
        pattern = pattern[1:]
    dir_only = pattern.endswith("/")
    pattern = pattern.rstrip("/")
    if not pattern:
        return None
    anchored = "/" in pattern

    out = []
    i, n = 0, len(pattern)
    while i < n:
        if pattern.startswith("**", i):
            full_segment = i == 0 or pattern[i - 1] == "/"
            after = pattern[i + 2:i + 3]
            if full_segment and after == "/":
                out.append("(?:[^/]+/)*")   # "**/" matches zero or more segments
                i += 3
            elif full_segment and i + 2 == n:
                out.append(".*")            # trailing "/**": everything below
                i += 2
            else:
                out.append("[^/]*")         # "**" inside a segment acts like "*"
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
    body = "".join(out)
    if dir_only:
        body += "(?:/.*)?"
    if anchored:
        return re.compile("^" + body + "$")
    return re.compile("^(?:[^/]+/)*" + body + "$")


def parse_rules(path: Path) -> tuple[list[Rule], list[int]]:
    """Parse TOML into ordered path rules and configuration error lines."""
    rules: list[Rule] = []
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8-sig"))
        if data.get("version") != 1 or set(data) - {"version", "rules"}:
            raise ValueError
        for entry in data.get("rules", []):
            if not isinstance(entry, dict) or set(entry) - {"patterns", "require", "exclude"}:
                raise ValueError
            patterns, files = entry.get("patterns"), entry.get("require", [])
            excluded = entry.get("exclude", False)
            if (not isinstance(patterns, list) or not patterns or
                    not all(isinstance(item, str) and item for item in patterns) or
                    not isinstance(files, list) or
                    not all(isinstance(item, str) and item for item in files) or
                    not isinstance(excluded, bool) or (excluded and files) or
                    (not excluded and not files)):
                raise ValueError
            normalised = tuple(item.replace("\\", "/") for item in files)
            for pattern in patterns:
                compiled = compile_pattern(pattern)
                if compiled is None:
                    raise ValueError
                rules.append(Rule(excluded, compiled, normalised))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError, ValueError, TypeError):
        return [], [1]
    return rules, []


def project_root() -> Path:
    """The project being worked on: CLAUDE_PROJECT_DIR, else the cwd."""
    root = os.environ.get("CLAUDE_PROJECT_DIR") if PROVIDER == "claude" else None
    return Path(root) if root else Path.cwd()


def normalise(path_text: str, root: Path) -> str | None:
    return common.relative(path_text, root)


def candidate_paths(tool_name: str, tool_input: dict[str, Any]) -> list[str]:
    return common.read_paths(tool_name, tool_input, project_root())


def matching_reminders(rules: list[Rule], rel_path: str) -> list[str]:
    """Reminder files for *rel_path*, honouring rule order and `!` lines.

    A matching `->` rule adds its files; a matching `!` rule clears
    everything matched so far, and later rules can add again.
    """
    found: list[str] = []
    seen: set[str] = set()
    for rule in rules:
        if not rule.pattern.match(rel_path):
            continue
        if rule.negated:
            found, seen = [], set()
        else:
            for reminder in rule.files:
                if reminder not in seen:
                    seen.add(reminder)
                    found.append(reminder)
    return found


def display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def emit(message: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": message,
        }
    }))


def main() -> int:
    try:
        if callable(getattr(sys.stdin, "reconfigure", None)):
            sys.stdin.reconfigure(encoding="utf-8", errors="strict")
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if not isinstance(event, dict):
        return 0

    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0

    root = project_root().resolve()
    # Keep policy lookup at the project root while shell paths follow the call's cwd.
    tool_input = dict(tool_input)
    if event.get("cwd"):
        tool_input.setdefault("cwd", event["cwd"])
    event["tool_input"] = tool_input
    common.observe(event, root, PROVIDER)
    if not common.successful(event.get("tool_response", {})):
        return 0

    # Bundled defaults, then shared user and project rules.
    sources: list[Path] = []
    seen_paths: set[Path] = set()
    for candidate in (
        Path(__file__).with_name(RULES_NAME),
        Path.home() / ".harness" / "guards" / RULES_NAME,
        root / ".harness" / "guards" / RULES_NAME,
    ):
        try:
            key = candidate.resolve()
        except OSError:
            continue
        if key in seen_paths or not candidate.is_file():
            continue
        seen_paths.add(key)
        sources.append(candidate)

    all_rules: list[Rule] = []
    invalid: list[str] = []
    for source in sources:
        rules, bad_lines = parse_rules(source)
        all_rules.extend(rules)
        if bad_lines:
            shown = ", ".join(str(n) for n in bad_lines[:3])
            extra = f" (+{len(bad_lines) - 3} more)" if len(bad_lines) > 3 else ""
            invalid.append(
                f"`{display_path(source, root)}` line(s) {shown}{extra} don't match the "
                "the TOML rule schema and were ignored"
            )

    triggers: list[str] = []
    reminders: list[str] = []
    seen_reminders: set[str] = set()
    for raw_path in common.read_paths(tool_name, tool_input, root):
        rel_path = normalise(raw_path, root)
        if rel_path is None:
            continue
        hits = matching_reminders(all_rules, rel_path)
        if hits and rel_path not in triggers:
            triggers.append(rel_path)
        for reminder in hits:
            if reminder not in seen_reminders:
                seen_reminders.add(reminder)
                reminders.append(reminder)

    parts = []
    if reminders:
        listing = []
        for reminder in reminders:
            missing = "" if (root / reminder).is_file() else " (missing)"
            listing.append(f"`{reminder}`{missing}")
        reads = ", ".join(f"`{p}`" for p in triggers[:3])
        if len(triggers) > 3:
            reads += ", ..."
        noun = "this file" if len(reminders) == 1 else "these files"
        parts.append(
            f"You just read {reads}, which matches {RULES_NAME}. "
            f"Read {noun} before continuing: {', '.join(listing)}."
        )
    if invalid:
        parts.append(". ".join(invalid) + ".")

    if parts:
        emit(" ".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
