#!/usr/bin/env python3
"""
Claude Code PostToolUse / PostToolUseFailure hook: fires after a shell command
has run (Bash or PowerShell).

If the command looks like it wrote to a file -- an output redirect, a heredoc
piped into `tee`, `sed -i`, an inline Python snippet calling `open(..., "w")`,
a PowerShell `Set-Content` -- it reminds Claude to use the built-in Write and
Edit tools instead. It never blocks: both events fire after the command already
ran, so there is nothing to undo. It only adds context via additionalContext.

The detection is deliberately generous. A shell write that slips through
unnoticed is expensive (a bad edit the interface never rendered as a diff); a
false positive costs one ignored sentence.
"""
import json
import re
import sys

# Anchors a command word: start of the string, or after a shell separator
# (; & | && ||), a newline, a subshell `(`, a brace group, a command
# substitution ($( or backtick), or one of the keywords that introduce a
# command inside a loop, conditional, or `xargs`/`-exec` invocation. Keeps
# `sed` from matching `parsed`, while still catching `for f in *; do sed -i`.
WORD = (
    r"(?:^|[;&|(`\n{]|\b(?:do|then|else|xargs|exec|time|nohup|env)\b)"
    r"\s*(?:sudo\s+)?"
)

# The interpreter rules below look for write-shaped source code, which is only
# a write when an interpreter is actually being run: these gates keep a grep
# for the literal text `.write(` from tripping them on its own.
PYTHON_CMD = re.compile(r"\b(?:python[0-9.]*|ipython|pypy[0-9.]*|uvx?)\b")
NODE_CMD = re.compile(r"\b(?:node|nodejs|bun|deno|npx|tsx|ts-node|esr)\b")

# Every rule is (label shown to Claude, pattern, gate). A command matching a
# pattern is treated as a file write, unless the rule has a gate that the
# command doesn't also match.
RULES = [
    (
        "in-place stream edit (sed -i / perl -i)",
        # `sed -i`, `sed -i.bak`, `perl -pi -e`, `ruby -i`: an -i flag anywhere
        # in the same command word's arguments.
        re.compile(WORD + r"(?:sed|perl|ruby)\b(?=[^;&|`\n]*(?:\s-[A-Za-z]*i\b|\s--in-place))"),
        None,
    ),
    (
        "awk -i inplace",
        re.compile(WORD + r"(?:g?awk)\b(?=[^;&|`\n]*inplace)"),
        None,
    ),
    (
        "tee",
        re.compile(WORD + r"tee\b"),
        None,
    ),
    (
        "inline Python writing a file",
        re.compile(
            # open(p, "w"), "a", "x", "r+", "wb" -- any mode that isn't read-only
            r"open\s*\([^)]*['\"][rwaxbt+]*[wax+][rwaxbt+]*['\"]"
            r"|\.write(?:lines)?\s*\("
            r"|\.write_(?:text|bytes)\s*\("
            r"|(?:json|yaml|toml|pickle|csv)\.dump\w*\s*\("
            r"|fileinput\.input\s*\([^)]*inplace"
            r"|\.truncate\s*\("
            r"|os\.(?:replace|rename|remove|unlink|makedirs|mkdir)\s*\("
            r"|shutil\.(?:copy\w*|move|rmtree)\s*\("
        ),
        PYTHON_CMD,
    ),
    (
        "inline Node writing a file",
        re.compile(
            # fs.writeFileSync, fs.promises.appendFile, fsp.rename, node:fs
            r"\bfsp?\w*\.(?:promises\.)?(?:writeFile|appendFile|createWriteStream|copyFile"
            r"|rename|truncate|mkdir|rm|rmdir|unlink|outputFile|writeJson\w*)\w*\s*\("
            # destructured: const { writeFile } = require("node:fs/promises")
            r"|\b(?:writeFile|appendFile|createWriteStream|copyFile|truncate|unlink|outputFile)"
            r"(?:Sync)?\s*\("
            # fs.openSync(p, "w") / fs.open(p, "a")
            r"|\bfsp?\w*\.open\w*\s*\([^)]*['\"][rwax+]"
            r"|\.write\s*\("
            r"|\bBun\.write\s*\("
            r"|\bDeno\.(?:writeTextFile|writeFile|create|truncate|rename|remove|copyFile)\w*\s*\("
        ),
        NODE_CMD,
    ),
    (
        "PowerShell file write",
        re.compile(
            r"\b(?:Set-Content|Add-Content|Out-File|Export-Csv|Export-Clixml|Set-Item)\b"
            r"|\bNew-Item\b(?=[^;|\n]*(?:-Value\b|-ItemType\s+File\b))"
            r"|\[(?:System\.)?IO\.File\]::(?:Write|Append|Create|Delete|Move)\w*",
            re.IGNORECASE,
        ),
        None,
    ),
    (
        "patch application",
        re.compile(WORD + r"patch\b|\bgit\s+apply\b"),
        None,
    ),
    (
        "dd/truncate",
        re.compile(WORD + r"(?:dd\b(?=[^;&|`\n]*\bof=)|truncate\b)"),
        None,
    ),
]

# An output redirect: `> file` or `>> file`. The operator has to start a word
# -- at the start of the command or after whitespace -- which is how shell
# redirects are written and how the sequences that merely look like one are
# ruled out: `2>` and other fd-prefixed redirects (almost always stderr/log
# capture, not authoring), `&>`, and the `->`, `=>`, `<div>`, `Vec<T>` that
# show up inside heredoc'd source code. The target is captured so the reminder
# can name it.
REDIRECT = re.compile(
    r"(?:^|(?<=\s))>>?\s*(?![&>|])(?P<target>\"[^\"]*\"|'[^']*'|[^\s;&|)`<>]+)"
)
# Sinks that discard output rather than write a file, on either platform.
NULL_SINKS = {"nul", "null", "$null", "con", "out-null", "-"}
WORD_CHAR = re.compile(r"\w")
NUMERIC = re.compile(r"^[\d.]+$")

REMINDER = (
    "That Bash/PowerShell command wrote to a file ({signals}). In Claude Code, "
    "the Write and Edit tools are the supported path for creating and modifying "
    "files: the interface renders their result as a reviewable diff, Edit fails "
    "loudly when its target string is missing or ambiguous, and the session's "
    "read tracking stays accurate. A shell write bypasses all of that -- the diff "
    "never appears in the transcript, and a quoting, escaping, or heredoc mistake "
    "silently produces the wrong bytes with a successful exit code. Write replaces "
    "a whole file; Edit changes part of one. Shelling out is worth it only when "
    "neither fits, such as capturing the output of a command that generates the "
    "file, and re-reading the file afterwards is how that gets verified."
)


def redirect_targets(command):
    """File-looking targets of `>`/`>>` in the command, in order."""
    out = []
    for match in REDIRECT.finditer(command):
        target = match.group("target").strip("\"'")
        low = target.lower()
        if not target or low in NULL_SINKS or low.startswith("/dev/"):
            continue
        # `x >> 1` (bit shift) and `if x >= 5` inside a heredoc'd script.
        if NUMERIC.match(target) or not WORD_CHAR.search(target):
            continue
        out.append(target)
    return out


def detect(command):
    """Labels for every write signal found in the command, deduped, in order."""
    signals = []
    targets = redirect_targets(command)
    if targets:
        head = targets[0]
        signals.append(f"redirect to {head[:60]}")

    for label, pattern, gate in RULES:
        if label in signals or not pattern.search(command):
            continue
        if gate is not None and not gate.search(command):
            continue
        signals.append(label)
    return signals


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    if not isinstance(data, dict):
        return 0

    # A missing or non-dict tool_input means there is no command to inspect;
    # never fail the surrounding call over malformed hook input.
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        return 0

    signals = detect(command)
    if not signals:
        return 0

    # The same script is registered on both events; echo back whichever fired.
    event = data.get("hook_event_name")
    if event not in ("PostToolUse", "PostToolUseFailure"):
        event = "PostToolUse"

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": REMINDER.format(signals="; ".join(signals)),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
