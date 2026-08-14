#!/usr/bin/env python3
"""
Claude Code PostToolUse hook: on-read-reminder.

Fires after a Read call, and after Bash commands that read files through
cat/more/less/head/tail/type. When the path being read matches a
gitignore-style pattern from an `on-read-reminder.rules` file, the hook
reminds the agent -- via additionalContext -- to read the file(s) the rule
maps to (a glossary, conventions doc, ...) before going further.

Rules file format (the shipped sample has the full description):

    # comment
    server/**/models/**  -> docs/GLOSSARY.md            one file
    **/migrations/**     -> docs/DB.md, docs/STYLE.md   several files
    !server/legacy/**                                   never remind

Two locations are read, in order (later rules can override earlier ones):
the hooks install directory (so a `--user` install can hold global rules),
then `$CLAUDE_PROJECT_DIR/.claude/` (project rules win). For a project
install both are the same file.

It never blocks: PostToolUse runs after the tool call already happened, so
the hook only adds context and always exits 0.
"""
import json
import os
import re
import sys
from pathlib import Path

RULES_NAME = "on-read-reminder.rules"

# Shell commands whose presence means "the agent is reading a file".
# `type` covers Windows' cmd, the others the usual Unix suspects.
READ_COMMANDS = re.compile(r"\b(cat|more|less|head|tail|type)\b")

# Quoted or bare whitespace-delimited token. Every token is tried against the
# rule patterns; tokens that aren't matching paths simply fire nothing.
TOKEN = re.compile(r'"([^"]+)"|\'([^\']+)\'|(\S+)')


class Rule:
    __slots__ = ("negated", "pattern", "files")

    def __init__(self, negated, pattern, files):
        self.negated = negated        # True for `!<pattern>` lines
        self.pattern = pattern        # compiled regex over a project-relative path
        self.files = files            # tuple of reminder files (empty for negations)


def compile_pattern(pattern):
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


def parse_rules(path):
    """Parse a rules file into (rules, invalid_line_numbers)."""
    rules, invalid = [], []
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


def project_root():
    """The project being worked on: CLAUDE_PROJECT_DIR, else the cwd."""
    root = os.environ.get("CLAUDE_PROJECT_DIR")
    return Path(root) if root else Path.cwd()


def normalise(path_text, root):
    """Project-relative, forward-slash form of *path_text*.

    Returns None for absolute paths outside the project: rules are written
    against project paths, so matching things like site-packages reads
    would only produce noise.
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


def candidate_paths(tool_name, tool_input):
    """Paths the tool call is reading, as written by the agent."""
    if tool_name == "Read":
        file_path = tool_input.get("file_path")
        return [file_path] if isinstance(file_path, str) and file_path else []
    if tool_name == "Bash":
        command = tool_input.get("command")
        if not isinstance(command, str) or not READ_COMMANDS.search(command):
            return []
        paths = []
        for match in TOKEN.finditer(command):
            token = match.group(1) or match.group(2) or match.group(3) or ""
            if token and not token.startswith("-"):
                paths.append(token)
        return paths
    return []


def matching_reminders(rules, rel_path):
    """Reminder files for *rel_path*, honouring rule order and `!` lines.

    A matching `->` rule adds its files; a matching `!` rule clears
    everything matched so far, and later rules can add again.
    """
    found, seen = [], set()
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


def display_path(path, root):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def emit(message):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": message,
        }
    }))


def main():
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0

    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0

    root = project_root()

    # Global rules first (the file next to the hook, in the install's
    # .claude/), then project rules, so project rules have the last word.
    # For a project install both resolve to the same file; load it once.
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

    all_rules, invalid = [], []
    for source in sources:
        rules, bad_lines = parse_rules(source)
        all_rules.extend(rules)
        if bad_lines:
            shown = ", ".join(str(n) for n in bad_lines[:3])
            extra = f" (+{len(bad_lines) - 3} more)" if len(bad_lines) > 3 else ""
            invalid.append(
                f"`{display_path(source, root)}` line(s) {shown}{extra} don't match the "
                f"'<pattern> -> <file>' or '!<pattern>' format and were ignored"
            )

    triggers, reminders = [], []
    seen_reminders = set()
    for raw_path in candidate_paths(tool_name, tool_input):
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
