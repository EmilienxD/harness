#!/usr/bin/env python3
"""
Claude Code / ChatGPT PreToolUse hook: on-edit-block.

Fires before native edits and recognized shell writes. When the file being edited matches a
gitignore-style pattern from an `on-edit-block.toml` file, the hook denies
the edit until the agent has read the file(s) the rule maps to (a style
guide, conventions doc, ...) that session.

Its TOML schema is shared with the sibling path guards: ordered `[[rules]]`
contain `patterns` and either `require` or `exclude = true`.

How a required file counts as "read":
- successful observed reads cover its complete current contents, or
- the hook already injected its full contents into a denial message this
  session (recorded in a per-session marker file in the temp dir).
  Guidance too large to inline stays blocked until completely read.

Denials are returned as PreToolUse JSON with permissionDecision "deny";
malformed input and non-matching tools/paths always exit 0 silently.

User rules load from `~/.harness/guards/`, then project rules from
`.harness/guards/`; later rules can override earlier ones.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import tomllib
from collections.abc import Iterable
from pathlib import Path
from typing import Any

# Installed beside hooks; the source checkout keeps internal dependencies separate.
_common_source = Path(__file__).resolve().parents[2] / "internal" / "path-guard-common"
if Path(__file__).resolve().parent.parent.name == "guards" and _common_source.is_dir():
    sys.path.insert(0, str(_common_source))
import path_guard_common as common

PROVIDER = "chatgpt" if "--chatgpt" in sys.argv else "claude"

RULES_NAME = "on-edit-block.toml"

# Hook output strings are capped by Claude Code; stay under the limit.
MESSAGE_LIMIT = 1800 if PROVIDER == "chatgpt" else 10000



class Rule:
    __slots__ = ("negated", "pattern", "files")

    def __init__(self, negated: bool, pattern: re.Pattern[str], files: tuple[str, ...]) -> None:
        self.negated = negated        # True for `!<pattern>` lines
        self.pattern = pattern        # compiled regex over a project-relative path
        self.files = files            # tuple of required files (empty for negations)



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


def matching_files(rules: list[Rule], rel_path: str) -> list[str]:
    """Required files for *rel_path*, honouring rule order and `!` lines.

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
            for required in rule.files:
                if required not in seen:
                    seen.add(required)
                    found.append(required)
    return found



def project_root() -> Path:
    """The project being worked on: CLAUDE_PROJECT_DIR, else the cwd."""
    root = os.environ.get("CLAUDE_PROJECT_DIR") if PROVIDER == "claude" else None
    return Path(root) if root else Path.cwd()


def normalise(path_text: str, root: Path) -> str | None:
    return common.relative(path_text, root)


def display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)



def marker_path(payload: dict[str, Any]) -> Path | None:
    """Per-session marker in the temp dir; None when the session can't be
    identified (hook then simply can't remember deliveries)."""
    session_id = payload.get("session_id") or ""
    safe = "".join(c for c in session_id if c.isalnum() or c in "-_")
    if not safe:
        return None
    return Path(tempfile.gettempdir()) / f"{PROVIDER}_on_edit_block_{safe}.marker"


def load_delivered(marker: Path | None) -> set[str]:
    if marker is None:
        return set()
    try:
        return {line.strip() for line in marker.read_text(encoding="utf-8").splitlines() if line.strip()}
    except OSError:
        return set()


def mark_delivered(marker: Path | None, files: Iterable[str]) -> None:
    if marker is None or not files:
        return
    try:
        delivered = sorted(load_delivered(marker) | set(files))
        marker.write_text("\n".join(delivered) + "\n", encoding="utf-8")
    except (OSError, UnicodeError):
        pass  # best-effort; worst case a file blocks again this session



def emit(output: dict[str, Any]) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", **output}}))


def build_deny_message(rel_path: str, missing: list[tuple[str, str]]) -> str:
    """Denial reason for the unread *missing* files [(path, content), ...].

    Contents are inlined in model order while the message stays under the
    hook output cap; files that don't fit are listed with an instruction to
    read them instead -- never a truncated dump.
    """
    def render(injected: list[tuple[str, str]], not_injected: list[tuple[str, str]]) -> str:
        lines = [f"Editing `{rel_path}` blocked: read the required file(s) first (see `{RULES_NAME}`)."]
        for path, _ in injected:
            lines.append(f"- `{path}` (content injected below)")
        for path, _ in not_injected:
            lines.append(f"- `{path}` (too large to inject here; read it with the Read tool)")
        lines.append("Follow them, then retry the edit.")
        message = "\n".join(lines)
        for path, content in injected:
            message += f"\n\n--- {path} ---\n{content}"
        return message

    injected = list(missing)
    while injected:
        not_injected = [item for item in missing if item not in injected]
        message = render(injected, not_injected)
        if len(message) <= MESSAGE_LIMIT:
            return message
        # Over the cap: stop injecting the largest content and try again.
        injected.remove(max(injected, key=lambda item: len(item[1])))
    return render([], missing)


def main() -> int:
    try:
        if callable(getattr(sys.stdin, "reconfigure", None)):
            sys.stdin.reconfigure(encoding="utf-8", errors="strict")
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if not isinstance(event, dict):
        return 0

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
    if event.get("hook_event_name") == "PostToolUse":
        return 0
    paths = [common.relative(path, root) for path in common.edit_paths(event.get("tool_name"), tool_input, root)]
    paths = list(dict.fromkeys(path for path in paths if path is not None))
    if not paths:
        return 0
    rel_path = ", ".join(paths)

    # Bundled defaults, then shared user and project rules.
    sources, seen_paths = [], set()
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

    all_rules, notes = [], []
    for source in sources:
        rules, bad_lines = parse_rules(source)
        all_rules.extend(rules)
        if bad_lines:
            shown = ", ".join(str(n) for n in bad_lines[:3])
            extra = f" (+{len(bad_lines) - 3} more)" if len(bad_lines) > 3 else ""
            notes.append(
                f"`{display_path(source, root)}` line(s) {shown}{extra} don't match the "
                "the TOML rule schema and were ignored."
            )

    required = list(dict.fromkeys(f for path in paths for f in matching_files(all_rules, path)))

    # Required files that don't exist on disk can never be read: don't block
    # on them (that would deadlock the edit), but report them -- per session,
    # the same way deliveries are reported once.
    readable, unreadable = [], []
    for required_file in required:
        try:
            content = (root / required_file).read_text(encoding="utf-8", errors="replace")
        except OSError:
            unreadable.append(required_file)
            continue
        readable.append((required_file, content))

    marker = marker_path(event)
    delivered = load_delivered(marker)

    fresh_unreadable = [f for f in unreadable if f not in delivered]
    if fresh_unreadable:
        notes.append(
            "Required by {0} but not readable, so {1} skipped: {2}. Fix the rules or create the file(s).".format(
                RULES_NAME,
                "it was" if len(fresh_unreadable) == 1 else "they were",
                ", ".join(f"`{f}`" for f in fresh_unreadable),
            )
        )

    already = delivered | common.confirmed_reads(event, [f for f, _ in readable], root, PROVIDER)
    missing = [(f, c) for f, c in readable if f not in already]

    if not missing:
        # All required files were read (or already injected): allow the edit,
        # but still surface config problems from the rules file(s).
        if notes:
            mark_delivered(marker, fresh_unreadable)
            emit({"additionalContext": " ".join(notes)})
        return 0

    message = build_deny_message(rel_path, missing)
    mark_delivered(marker, [f for f, content in missing if f"\n\n--- {f} ---\n{content}" in message] + fresh_unreadable)
    if notes:
        message += "\n\n" + " ".join(notes)
    emit({"permissionDecision": "deny", "permissionDecisionReason": message})
    return 0


if __name__ == "__main__":
    sys.exit(main())
