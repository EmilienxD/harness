# prefer-read-tool

A `PostToolUse` hook that notices when Claude reads a file with shell commands
like `cat`, `sed`, `awk`, `head`, `tail`, `nl`, or PowerShell's `Get-Content` /
`Select-String` family, and reminds it, once per offending command, to use the
built-in **Read** tool instead.

The write-side counterpart is [`prefer-edit-tool`](../prefer-edit-tool/README.md);
the two are independent and install cleanly side by side.

## Problem

Left to itself, Claude often shells out to `cat file`, `sed -n '1,50p' file`,
`awk 'NR>=10 && NR<=40' file`, `head file`, `tail file`, or `nl file` to look at a file.
That works, but it goes through a shell (quoting and escaping pitfalls), lacks
line-range and large-file handling, and bypasses the read-tracking the Read
tool provides. Habits like this are best corrected with a nudge at the moment
they happen, not a paragraph in a system prompt.

## Solution

Register a `PostToolUse` hook with a `Bash|PowerShell` matcher — matching
`Bash` alone misses Windows setups where the PowerShell tool is the primary
shell, and on Windows without Git Bash the Bash tool isn't registered at all.
After every shell call — successful ones only, that's when `PostToolUse` fires
— the hook scans the command for `cat`/`sed`/`awk`/`head`/`tail`/`nl`,
PowerShell `Get-Content` aliases (`gc`, `type`, `cat`), `Select-String` aliases, and
`[IO.File]::ReadAllText` used as a command word: start of the command, or after
`;`, `&&`, `|`, `(`, `` ` ``, a newline …, so `foo; cat f` and `echo $(cat f)`
count but `concatenate` and `rg --type py` don't. On a match it returns
`additionalContext` explaining why Read is preferable, which Claude Code
attaches next to the tool result.

The hook **never blocks anything**. `PostToolUse` runs after the command has
already executed, so there is nothing to undo — it can only add context. A
command viewed inside a string that happens to contain `; cat` may trigger a
spurious reminder; the cost of a false positive is one ignored sentence.

Legitimate stream-processing uses can also trigger the reminder. That is the
intended trade-off: this hook is a nudge for file reads, not a command blocker.

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers the hook on the `PostToolUse` event with a `Bash\|PowerShell` matcher |
| `.claude/hooks/prefer_read_tool_PostToolUse_hook.py` | Scans the executed command and emits the reminder |

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install prefer-read-tool
```

That copies the hook into `.claude/hooks/`, marks it executable, and merges
the `PostToolUse` registration below into `.claude/settings.json` without
disturbing any hooks you already had. Add `--dry` first to see the exact
file list and settings diff. See the [repo README](../../README.md) for
`--user`, `--local`, and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy `hooks/prefer_read_tool_PostToolUse_hook.py` into `.claude/hooks/` in your repo.
2. Make it executable: `chmod +x .claude/hooks/prefer_read_tool_PostToolUse_hook.py`
3. Add (or merge) the following into your repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/prefer_read_tool_PostToolUse_hook.py"]
          }
        ]
      }
    ]
  }
}
```

`command` must resolve on the PATH of the machine running Claude Code
(`python` on Windows, usually `python3` elsewhere). The `harness` installer
sidesteps this: it checks each candidate (`python3`, `python`, `py`) actually
runs and writes its absolute path into `settings.json`, so the hook no longer
depends on PATH at all.

</details>

Restart or reload Claude Code so it picks up the new hook config, then test
it: ask the agent to `nl README.md`. The tool result should come back with
the reminder attached as context.

Requires a working Python 3 where the installer runs — its absolute path is
baked into the hook config, so the interpreter does not need to stay on PATH
afterwards.
