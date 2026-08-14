#!/usr/bin/env python3
"""
Claude Code PostToolUse hook: fires after a Bash command has run.

If the command invoked `cat` or `sed`, it reminds Claude to prefer the
built-in Read tool for file reads. It never blocks -- PostToolUse fires
after the command already executed, so there's nothing to undo. It only
adds context via additionalContext.
"""
import json
import re
import sys

# Match `cat` or `sed` as a standalone command word: at the start of the
# command, or after a shell separator (; & | && ||), a subshell `(`, or a
# command substitution ($( or backtick), possibly with leading whitespace.
# \b keeps this from matching things like `concatenate` or a variable named
# `catfile`.
CAT_SED = re.compile(r"(^|[;&|(`]+)\s*(cat|sed)\b")

REMINDER = (
    "This command used cat/sed to read a file. For reading file contents, "
    "prefer the built-in Read tool instead of shelling out to cat/sed -- "
    "it's faster, avoids shell-quoting/escaping issues, and has built-in "
    "support for line ranges and large files."
)


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0

    # A missing or non-dict tool_input means there is no command to inspect;
    # never fail the surrounding Bash call over malformed hook input.
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        return 0

    if CAT_SED.search(command):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": REMINDER,
            }
        }))

    return 0


if __name__ == "__main__":
    sys.exit(main())
