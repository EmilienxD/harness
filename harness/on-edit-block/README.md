# on-edit-block

A `PreToolUse` hook that **denies** a `Write`/`Edit`/`MultiEdit` on files you
protect until the agent has read the file(s) you require first — a style
guide, conventions doc, architecture notes — during the current session.

The sibling tool [`on-read-reminder`](../on-read-reminder/README.md) only
reminds; this one blocks. Same rules-file format, opposite strength.

## Problem

A `CLAUDE.md` line saying "read `docs/PYTHON-GUIDE.md` before editing models"
is read once at session start and fades — or is skipped when the agent
beelines for an edit. Some files genuinely gate correct edits. A hard denial
at the moment of the edit, with the required content attached, is the only
hint that can't be missed.

## Solution

Register a `PreToolUse` hook with a `Write|Edit|MultiEdit` matcher. Before an
edit lands, the hook checks the target path against your rules. If required
files haven't been read this session, it returns `permissionDecision: "deny"`
with the required files' **full contents inlined** in the denial reason (or a
"read it yourself" instruction when they don't fit the 10k hook-output cap).
Failed edits cost the agent nothing but a retry — and it retries already
knowing the guide.

**Each required file blocks at most once per session.** A file counts as read
when the session transcript shows a `Read` (or a Bash
`cat`/`more`/`less`/`head`/`tail`/`type`) of it, or when the hook already
injected its contents into an earlier denial — recorded in a per-session
marker in the temp dir. No marker, no memory: sessions restart clean.

Transcripts are written asynchronously, so a read from the *current* turn may
not be flushed yet; worst case you get one extra denial whose retry passes.

## The rules file: `.claude/on-edit-block.rules`

The installer drops a starter file (all comments) at
`.claude/on-edit-block.rules`. Identical format to on-read-reminder:

```
# <pattern> -> <file>[, <file>...]   require reading <file>(s) first
# !<pattern>                         never require for these paths

server/**/models/**          -> docs/coding-standards/PYTHON-PREFERENCES.md
desktop/client/**/models/**  -> docs/coding-standards/PYTHON-PREFERENCES.md
**/migrations/**             -> docs/DB.md, docs/STYLE.md
!server/legacy/**
```

Gitignore semantics: `*`/`?` match within one segment, `**` matches any
number of segments (`a/**/b` also matches `a/b`), a pattern with a slash is
anchored at the project root, one without matches the basename at any depth,
a trailing slash targets a directory and everything under it. Rules apply
top to bottom: `->` adds, `!` clears what matched so far, later lines can
add again. Required paths are relative to the project root.

Robustness, in the spirit of "loudly broken beats silently dead":

- Required files missing from disk **never block** (that would deadlock the
  edit) — they're reported once per session instead.
- Lines that don't parse are reported (and ignored) on matching edits.
- Absolute paths outside the project root never match.

With a `--user` install, the hook also reads `~/.claude/on-edit-block.rules`
as *global* rules, applied before the project's own file (so project rules
have the last word).

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers the hook on the `PreToolUse` event with a `Write\|Edit\|MultiEdit` matcher |
| `.claude/hooks/on_edit_block_PreToolUse_hook.py` | Matches edit targets, scans the transcript for prior reads, denies or allows |
| `.claude/on-edit-block.rules` | Your pattern → required-files mapping (starter file is all comments) |

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install on-edit-block
```

That copies the hook and starter rules file into `.claude/`, marks the hook
executable, and merges the `PreToolUse` registration below into
`.claude/settings.json` without disturbing any hooks you already had. Add
`--dry` first to see the exact file list and settings diff. See the
[repo README](../../README.md) for `--user`, `--local`, and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy `hooks/on_edit_block_PreToolUse_hook.py` into `.claude/hooks/` in your repo.
2. Make it executable: `chmod +x .claude/hooks/on_edit_block_PreToolUse_hook.py`
3. Copy `on-edit-block.rules` into `.claude/` and write your rules.
4. Add (or merge) the following into your repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/on_edit_block_PreToolUse_hook.py"]
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
it: write a rule, ask the agent to edit a matching file. The edit should be
denied once with your required file's content attached; the retry passes.

Requires a working Python 3 where the installer runs — its absolute path is
baked into the hook config, so the interpreter does not need to stay on PATH
afterwards. No other dependencies — the hook is stdlib-only.
