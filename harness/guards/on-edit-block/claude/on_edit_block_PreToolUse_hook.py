#!/usr/bin/env python3
"""
Claude Code PreToolUse hook: on-edit-block.

Fires before Write/Edit/MultiEdit. When the file being edited matches a
gitignore-style pattern from an `on-edit-block.rules` file, the hook denies
the edit until the agent has read the file(s) the rule maps to (a style
guide, conventions doc, ...) that session.

Rules file -- same format as the sibling on-read-reminder tool:

    # comment
    server/**/models/**   -> docs/PYTHON-GUIDE.md            one file
    **/migrations/**      -> docs/DB.md, docs/STYLE.md       several files
    !server/legacy/**                                        never require

How a required file counts as "read":
- a Read (or a Bash cat/more/less/head/tail/type) of it appears earlier in
  the session transcript, or
- the hook already injected its full contents into a denial message this
  session (recorded in a per-session marker file in the temp dir, so each
  file blocks at most once per session and retries are not denied again).

Denials are returned as PreToolUse JSON with permissionDecision "deny";
malformed input and non-matching tools/paths always exit 0 silently.

Two rules locations are read, in order (later rules can override earlier
ones): the hooks install directory (so a `--user` install can hold global
rules), then `$CLAUDE_PROJECT_DIR/.claude/` (project rules win).
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

RULES_NAME = "on-edit-block.rules"

# Hook output strings are capped by Claude Code; stay under the limit.
MESSAGE_LIMIT = 10000

EDIT_TOOLS = {"Write", "Edit", "MultiEdit"}

# Tool names that count as "reading" when scanning the transcript for prior
# reads. `Read` is what Claude Code uses; the aliases cover SDK harnesses.
READ_TOOLS = {"Read", "read_file", "view"}

# Shell commands whose presence in a Bash call mean "the agent read a file".
READ_COMMANDS = re.compile(r"\b(cat|more|less|head|tail|type)\b")

# Quoted or bare whitespace-delimited token inside a shell command.
TOKEN = re.compile(r'"([^"]+)"|\'([^\']+)\'|(\S+)')


class Rule:
    __slots__ = ("negated", "pattern", "files")

    def __init__(self, negated: bool, pattern: re.Pattern[str], files: tuple[str, ...]) -> None:
        self.negated = negated        # True for `!<pattern>` lines
        self.pattern = pattern        # compiled regex over a project-relative path
        self.files = files            # tuple of required files (empty for negations)


# --- rules parsing: identical to harness/on-read-reminder -----------------

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
    """Parse a rules file into (rules, invalid_line_numbers)."""
    rules: list[Rule] = []
    invalid: list[int] = []
    try:
        # utf-8-sig: tolerate a BOM left by Windows editors
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return rules, invalid
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # gitignore-style escape of a literal leading # or !
        escaped = line.startswith("\\#") or line.startswith("\\!")
        if escaped:
            line = line[1:]
        if not escaped and line.startswith("!"):
            pattern = line[1:].strip()
            compiled = compile_pattern(pattern) if pattern and "->" not in pattern else None
        elif "->" in line:
            pattern, _, targets = line.partition("->")
            files = tuple(
                f.strip().replace("\\", "/") for f in targets.split(",") if f.strip()
            )
            compiled = compile_pattern(pattern) if files else None
            if compiled is not None:
                rules.append(Rule(False, compiled, files))
                continue
        else:
            compiled = None
        if compiled is not None:
            rules.append(Rule(True, compiled, ()))
        else:
            invalid.append(number)
    return rules, invalid


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


# --- paths -----------------------------------------------------------------

def project_root() -> Path:
    """The project being worked on: CLAUDE_PROJECT_DIR, else the cwd."""
    root = os.environ.get("CLAUDE_PROJECT_DIR")
    return Path(root) if root else Path.cwd()


def normalise(path_text: str, root: Path) -> str | None:
    """Project-relative, forward-slash form of *path_text*.

    Returns None for absolute paths outside the project: rules are written
    against project paths.
    """
    if Path(path_text).is_absolute():
        try:
            return Path(path_text).resolve().relative_to(root.resolve()).as_posix()
        except (ValueError, OSError):
            return None
    raw = path_text.replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    return raw or None


def display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


# --- transcript scan --------------------------------------------------------

def _iter_tool_use_blocks(obj: object) -> Iterator[dict[str, Any]]:
    """Yield every {"type": "tool_use", "name": ...} dict nested in *obj*.

    Transcript entries nest tool calls (message.content[...]), so walk
    generically rather than assuming an exact shape.
    """
    if isinstance(obj, dict):
        if obj.get("type") == "tool_use" and "name" in obj:
            yield obj
        for value in obj.values():
            yield from _iter_tool_use_blocks(value)
    elif isinstance(obj, list):
        for item in obj:
            yield from _iter_tool_use_blocks(item)


def _read_candidates(tool_use: dict[str, Any]) -> list[str]:
    """Raw path strings a tool_use block read, best-effort."""
    name = tool_use.get("name")
    tool_input = tool_use.get("input") or {}
    if name in READ_TOOLS:
        candidate = (
            tool_input.get("file_path")
            or tool_input.get("path")
            or tool_input.get("filePath")
        )
        return [candidate] if isinstance(candidate, str) and candidate else []
    if name == "Bash":
        command = tool_input.get("command")
        if not isinstance(command, str) or not READ_COMMANDS.search(command):
            return []
        out = []
        for match in TOKEN.finditer(command):
            token = match.group(1) or match.group(2) or match.group(3) or ""
            if token and not token.startswith("-"):
                out.append(token)
        return out
    return []


def transcript_reads(transcript_path: str, needed: Iterable[str], root: Path) -> set[str]:
    """Which of *needed* (project-relative paths) were read this session.

    Scans the JSONL transcript for prior Read/Bash-cat calls. Stops early
    once everything needed is accounted for; any parse problem just means
    "not confirmed read", never a crash.
    """
    found: set[str] = set()
    remaining = set(needed)
    if not transcript_path or not remaining:
        return found
    path = Path(transcript_path)
    if not path.is_file():
        return found
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for tool_use in _iter_tool_use_blocks(entry):
                    for candidate in _read_candidates(tool_use):
                        rel = normalise(candidate, root)
                        if rel in remaining:
                            found.add(rel)
                            remaining.discard(rel)
                if not remaining:
                    return found
    except OSError:
        pass
    return found


# --- session marker ---------------------------------------------------------

def marker_path(payload: dict[str, Any]) -> Path | None:
    """Per-session marker in the temp dir; None when the session can't be
    identified (hook then simply can't remember deliveries)."""
    session_id = payload.get("session_id") or ""
    safe = "".join(c for c in session_id if c.isalnum() or c in "-_")
    if not safe:
        return None
    return Path(tempfile.gettempdir()) / f"claude_on_edit_block_{safe}.marker"


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
    except OSError:
        pass  # best-effort; worst case a file blocks again this session


# --- output -----------------------------------------------------------------

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
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if not isinstance(event, dict):
        return 0

    if event.get("tool_name") not in EDIT_TOOLS:
        return 0
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return 0

    root = project_root()
    rel_path = normalise(file_path, root)
    if rel_path is None:
        return 0

    # Global rules first (next to the hook, in the install's .claude/), then
    # project rules, so project rules have the last word. For a project
    # install both resolve to the same file; load it once.
    sources, seen_paths = [], set()
    hook_adjacent = Path(__file__).resolve().parent.parent / RULES_NAME
    for candidate in (hook_adjacent, root / ".claude" / RULES_NAME):
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
                f"'<pattern> -> <file>' or '!<pattern>' format and were ignored."
            )

    required = matching_files(all_rules, rel_path)

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

    already = delivered | transcript_reads(event.get("transcript_path", ""), [f for f, _ in readable], root)
    missing = [(f, c) for f, c in readable if f not in already]

    if not missing:
        # All required files were read (or already injected): allow the edit,
        # but still surface config problems from the rules file(s).
        if notes:
            mark_delivered(marker, fresh_unreadable)
            emit({"additionalContext": " ".join(notes)})
        return 0

    message = build_deny_message(rel_path, missing)
    mark_delivered(marker, [f for f, _ in missing] + fresh_unreadable)
    if notes:
        message += "\n\n" + " ".join(notes)
    emit({"permissionDecision": "deny", "permissionDecisionReason": message})
    return 0


if __name__ == "__main__":
    sys.exit(main())
