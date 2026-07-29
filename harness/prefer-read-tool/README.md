# prefer-read-tool

A `PostToolUse` hook that notices when Claude reads a file with `cat` or `sed`
in a Bash command and reminds it, once per offending command, to use the
built-in **Read** tool instead.

## Problem

Left to itself, Claude often shells out to `cat file` or `sed -n '1,50p' file`
to look at a file. That works, but it goes through a shell (quoting and
escaping pitfalls), lacks line-range and large-file handling, and bypasses the
read-tracking the Read tool provides. Habits like this are best corrected with
a nudge at the moment they happen, not a paragraph in a system prompt.

## Solution

Register a `PostToolUse` hook with a `Bash` matcher. After every Bash call —
successful ones only, that's when `PostToolUse` fires — the hook scans the
command for `cat`/`sed` used as a command word (start of the command, or after
`;`, `&&`, `|`, `(`, `` ` `` …, so `foo; cat f` and `echo $(cat f)` count but
`concatenate` doesn't). On a match it returns `additionalContext` explaining
why Read is preferable, which Claude Code attaches next to the tool result.

The hook **never blocks anything**. `PostToolUse` runs after the command has
already executed, so there is nothing to undo — it can only add context. A
command viewed inside a string that happens to contain `; cat` may trigger a
spurious reminder; the cost of a false positive is one ignored sentence.

Legitimate `sed` uses (in-place substitution, stream editing of piped data)
also trigger the reminder — that's why it says *"reserve sed for actual
stream-editing tasks"* rather than *"never use sed"*.

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers the hook on the `PostToolUse` event with a `Bash` matcher |
| `.claude/hooks/prefer_read_tool_hook.py` | Scans the executed command and emits the reminder |

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install prefer-read-tool
```

That copies the hook into `.claude/hooks/`, marks it executable, and merges
the `PostToolUse` registration below into `.claude/settings.json` without
disturbing any hooks you already had. Add `--dry-run` first to see the exact
file list and settings diff. See the [repo README](../../README.md) for
`--user`, `--local`, and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy `hooks/prefer_read_tool_hook.py` into `.claude/hooks/` in your repo.
2. Make it executable: `chmod +x .claude/hooks/prefer_read_tool_hook.py`
3. Add (or merge) the following into your repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/prefer_read_tool_hook.py"]
          }
        ]
      }
    ]
  }
}
```

`python3` must exist on `PATH` on the machine running Claude Code — on Windows
that is usually `python` instead. (The installer picks the right one for you.)

</details>

Restart or reload Claude Code so it picks up the new hook config, then test
it: ask the agent to `cat README.md`. The tool result should come back with
the reminder attached as context.

Requires `python3` (or `python`) on PATH inside the environment Claude Code
runs in.
