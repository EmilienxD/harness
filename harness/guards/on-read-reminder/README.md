# on-read-reminder

A `PostToolUse` hook that reminds Claude to read the files *you* consider
essential — a glossary, conventions doc, architecture notes — the moment it
reads a path that makes them relevant, defined by gitignore-style patterns.

Two siblings key off *edits* instead of reads, with the same rules-file
format: [`on-edit-reminder`](../on-edit-reminder/README.md) lets the edit land
and then requires the reading, and [`on-edit-block`](../on-edit-block/README.md)
denies the edit until the reading has happened.

## Problem

Some files matter before touching whole areas of a codebase: read
`server/api/models/user.py` and you really should have read
`docs/GLOSSARY.md` first. Hints in `CLAUDE.md` are read once at session
start and fade; a reminder attached to the exact read that makes the file
relevant lands when it can still change what happens next.

## Solution

Register a `PostToolUse` hook with a `Read|Bash` matcher. After every Read —
and after Bash commands that read files through `cat`/`more`/`less`/`head`/
`tail`/`type` — the hook checks the read path against your rules. On a match
it returns `additionalContext` naming the file(s) to read, which Claude Code
attaches next to the tool result. Several matching rules contribute several
files; the reminder lists them all.

The hook **never blocks anything**: `PostToolUse` runs after the tool call
already happened, so it can only add context.

## The rules file: `.claude/on-read-reminder.rules`

The installer drops a starter file (all comments) at
`.claude/on-read-reminder.rules`. Each line maps a gitignore-style pattern
to the file(s) to read:

```
# <pattern> -> <file>[, <file>...]   remind the agent to read <file>(s)
# !<pattern>                         never remind for these paths

server/**/models/**          -> docs/GLOSSARY.md
shared/**/models/**          -> docs/GLOSSARY.md
desktop/client/**/models/**  -> docs/GLOSSARY.md
**/migrations/**             -> docs/DB.md, docs/STYLE.md
!server/legacy/**
```

Patterns are matched against the project-relative path, with familiar
gitignore semantics:

- `*` and `?` match within one path segment, `**` matches any number of
  segments (`a/**/b` also matches `a/b`).
- A pattern containing a slash is anchored at the project root; one without
  matches the file's basename at any depth (`GLOSSARY.md` matches anywhere).
- A trailing slash targets a directory and everything under it.
- Rules apply top to bottom: a matching `->` line adds its file(s), a
  matching `!` line clears everything matched so far, and later lines can
  add again.

Reminder paths are relative to the project root; a reminder pointing at a
file that doesn't exist is flagged `(missing)` so you notice stale rules.
Lines that don't parse are reported once per matching tool call — loudly
broken beats silently dead — and are otherwise ignored.

With a `--user` install, the hook also reads `~/.claude/on-read-reminder.rules`
as *global* rules, applied before the project's own file (so project rules
have the last word). Absolute paths outside the project root never match —
reading site-packages shouldn't nag you about your project's glossary.

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers the hook on the `PostToolUse` event with a `Read\|Bash` matcher |
| `.claude/hooks/on_read_reminder_PostToolUse_hook.py` | Matches read paths against the rules and emits the reminder |
| `.claude/on-read-reminder.rules` | Your pattern → files mapping (starter file is all comments) |

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

That copies the hook and starter rules file into `.claude/`, marks the hook
executable, and merges the `PostToolUse` registration below into
`.claude/settings.json` without disturbing any hooks you already had. Add
`--dry` first to see the exact file list and settings diff. See the
[repo README](../../README.md) for `--user`, `--local`, and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy `hooks/on_read_reminder_PostToolUse_hook.py` into `.claude/hooks/` in your repo.
2. Make it executable: `chmod +x .claude/hooks/on_read_reminder_PostToolUse_hook.py`
3. Copy `on-read-reminder.rules` into `.claude/` and write your rules.
4. Add (or merge) the following into your repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/on_read_reminder_PostToolUse_hook.py"]
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
it: write a rule, ask the agent to read a matching file, and the tool result
should come back with your reminder attached as context.

Requires a working Python 3 where the installer runs — its absolute path is
baked into the hook config, so the interpreter does not need to stay on PATH
afterwards. No other dependencies — the hook is stdlib-only.
