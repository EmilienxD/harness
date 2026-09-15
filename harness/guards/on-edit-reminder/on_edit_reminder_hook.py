#!/usr/bin/env python3
"""
Claude Code PostToolUse hook: on-edit-reminder.

Fires after Write/Edit/MultiEdit. When the file that was just edited matches a
gitignore-style pattern from an `on-edit-reminder.toml` file, the hook lets
the edit stand and instead injects a reminder -- via additionalContext -- to
read the file(s) the rule maps to (a style guide, conventions doc, ...) and to
immediately correct anything already written that doesn't follow them.

Its TOML schema is shared with the sibling path guards: ordered `[[rules]]`
contain `patterns` and either `require` or `exclude = true`.

Why remind instead of deny (that's on-edit-block's job): a denial throws away a
whole Write and buys a full rewrite, even when the agent's first attempt
already followed the guide. Letting the edit land and patching the parts that
don't comply is the cheaper path in tokens; the reminder's job is to make sure
the patching actually happens.

Repeat behaviour: a required file is reminded about until the session
transcript shows it was actually read, and at most once every
REMIND_INTERVAL_SECONDS per file (a burst of edits in one turn produces one
reminder, an ignored reminder comes back). Deliveries are recorded in a
per-session marker file in the temp dir.

User rules load from `~/.harness/guards/`, then project rules from
`.harness/guards/`; later rules can override earlier ones.

It never blocks: PostToolUse runs after the edit already happened, so the hook
only adds context and always exits 0.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tomllib
import tempfile
import time
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

RULES_NAME = "on-edit-reminder.toml"

# Hook output strings are capped by Claude Code; stay under the limit.
MESSAGE_LIMIT = 10000

# At most this many required files are named in one reminder; the rest are
# summarised as "+N more" so a sprawling rules file can't bloat the message.
MAX_LISTED = 10

# A given required file is not re-reminded more often than this. Long enough
# that a burst of edits in one turn is a single reminder, short enough that an
# ignored reminder comes back while the work is still in flight.
REMIND_INTERVAL_SECONDS = 120

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



def marker_path(payload: dict[str, Any]) -> Path | None:
    """Per-session marker in the temp dir; None when the session can't be
    identified (the hook then simply can't remember deliveries)."""
    session_id = payload.get("session_id") or ""
    safe = "".join(c for c in session_id if c.isalnum() or c in "-_")
    if not safe:
        return None
    return Path(tempfile.gettempdir()) / f"claude_on_edit_reminder_{safe}.marker"


def load_reminded(marker: Path | None) -> dict[str, float]:
    """{key: last delivery epoch} from the marker; {} when unreadable."""
    if marker is None:
        return {}
    out: dict[str, float] = {}
    try:
        text = marker.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        stamp, _, key = line.partition("\t")
        if not key.strip():
            continue
        try:
            out[key.strip()] = float(stamp)
        except ValueError:
            continue
    return out


def mark_reminded(marker: Path | None, reminded: dict[str, float], keys: Iterable[str], now: float) -> None:
    if marker is None or not keys:
        return
    updated = dict(reminded)
    for key in keys:
        updated[key] = now
    try:
        marker.write_text(
            "".join(f"{stamp}\t{key}\n" for key, stamp in sorted(updated.items())),
            encoding="utf-8",
        )
    except OSError:
        pass  # best-effort; worst case the same reminder repeats sooner


def due(reminded: dict[str, float], key: str, now: float, interval: float | None = REMIND_INTERVAL_SECONDS) -> bool:
    """True when *key* is worth emitting again.

    *interval* None means once per session and never again -- right for
    config diagnostics, which the agent can't act on, unlike the required
    reading, which has to keep asking until it happens.
    """
    last = reminded.get(key)
    if last is None:
        return True
    return interval is not None and now - last >= interval



def emit(message: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": message,
        }
    }))


def listing(files: list[str]) -> str:
    """`a`, `b` and 2 more -- bounded so the message stays small."""
    shown = [f"`{f}`" for f in files[:MAX_LISTED]]
    extra = len(files) - len(shown)
    if extra:
        shown.append(f"{extra} more")
    if len(shown) == 1:
        return shown[0]
    return ", ".join(shown[:-1]) + " and " + shown[-1]


def build_message(rel_path: str, missing: list[str]) -> str:
    """The reminder for required files *missing* after editing *rel_path*."""
    them = "it" if len(missing) == 1 else "them"
    files = listing(missing)
    return (
        f"You just edited `{rel_path}`, which `{RULES_NAME}` ties to required reading: "
        f"{files}. The edit was allowed, not checked -- nothing here says it complies.\n"
        f"Read {them} now, with the Read tool, before your next edit. Then re-check "
        f"`{rel_path}` and every other file you have changed this session against {them}, "
        f"and correct every violation you find immediately -- do not defer the corrections "
        f"to the end of the task, and do not report the work as done while one stands. "
        f"Fixing the parts that don't comply is what this reminder is for; rewriting "
        f"compliant code is not."
    )


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

    # Diagnostics are collected as (marker key, text) so they can be reported
    # once per session rather than on every edit of a long one.
    all_rules: list[Rule] = []
    diagnostics: list[tuple[str | None, str]] = []
    for source in sources:
        rules, bad_lines = parse_rules(source)
        all_rules.extend(rules)
        if bad_lines:
            shown = ", ".join(str(n) for n in bad_lines[:3])
            extra = f" (+{len(bad_lines) - 3} more)" if len(bad_lines) > 3 else ""
            diagnostics.append((
                f"badlines:{display_path(source, root)}:{shown}{extra}",
                f"`{display_path(source, root)}` line(s) {shown}{extra} don't match the "
                "the TOML rule schema and were ignored.",
            ))

    required = matching_files(all_rules, rel_path)

    # A required file that isn't on disk can never be read: reporting the
    # broken rule beats telling the agent to read something that isn't there.
    existing: list[str] = []
    unreadable: list[str] = []
    for required_file in required:
        if (root / required_file).is_file():
            existing.append(required_file)
        else:
            unreadable.append(required_file)

    now = time.time()
    marker = marker_path(event)
    reminded = load_reminded(marker)

    fresh_unreadable = [f for f in unreadable if due(reminded, f"missing:{f}", now, None)]
    if fresh_unreadable:
        diagnostics.append((
            None,  # already keyed per file below
            "Required by {0} but not readable, so {1} skipped: {2}. Fix the rules or create the file(s).".format(
                RULES_NAME,
                "it was" if len(fresh_unreadable) == 1 else "they were",
                ", ".join(f"`{f}`" for f in fresh_unreadable),
            ),
        ))

    already_read = transcript_reads(event.get("transcript_path", ""), existing, root)
    missing = [f for f in existing if f not in already_read and due(reminded, f, now)]

    fresh_diagnostics = [
        (key, text) for key, text in diagnostics if key is None or due(reminded, key, now, None)
    ]

    parts = []
    if missing:
        parts.append(build_message(rel_path, missing))
    parts.extend(text for _, text in fresh_diagnostics)
    if not parts:
        return 0

    mark_reminded(
        marker,
        reminded,
        missing
        + [f"missing:{f}" for f in fresh_unreadable]
        + [key for key, _ in fresh_diagnostics if key is not None],
        now,
    )
    emit("\n".join(parts)[:MESSAGE_LIMIT])
    return 0


if __name__ == "__main__":
    sys.exit(main())
