#!/usr/bin/env python3
"""
Claude Code PostToolUse hook: fires after a shell command has run (Bash or
PowerShell).

If the command invoked `cat`, `sed`, or PowerShell's `Get-Content`, it reminds
Claude to prefer the built-in Read tool for file reads. It never blocks --
PostToolUse fires after the command already executed, so there's nothing to
undo. It only adds context via additionalContext.
"""
from __future__ import annotations

import json
import re
import sys

# Match `cat` or `sed` as a standalone command word: at the start of the
# command, or after a shell separator (; & | && ||), a newline, a subshell `(`,
# or a command substitution ($( or backtick), possibly with leading whitespace.
# \b keeps this from matching things like `concatenate` or a variable named
# `catfile`.
CAT_SED = re.compile(r"(^|[;&|(`\n]+)\s*(cat|sed)\b")

# The PowerShell tool is a separate tool doing the same job, and on Windows it
# is often the only shell Claude has, so its read cmdlets get the same
# reminder. Requiring a command-word position keeps `type` from matching
# `rg --type py`.
GET_CONTENT = re.compile(
    r"(^|[;&|(`\n]+)\s*(Get-Content|gc|type)\b"
    r"|\[(?:System\.)?IO\.File\]::Read\w*",
    re.IGNORECASE,
)

REMINDER = (
    "This command used cat/sed/Get-Content to read a file. For reading file "
    "contents, prefer the built-in Read tool instead of shelling out -- "
    "it's faster, avoids shell-quoting/escaping issues, and has built-in "
    "support for line ranges and large files."
)


def main() -> int:
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

    if CAT_SED.search(command) or GET_CONTENT.search(command):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": REMINDER,
            }
        }))

    return 0


if __name__ == "__main__":
    sys.exit(main())
