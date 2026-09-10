# on-edit-reminder

A `PostToolUse` hook that lets a `Write`/`Edit`/`MultiEdit` on files you
protect **land**, then requires the agent to read the file(s) you name — a
style guide, conventions doc, architecture notes — and to fix, immediately,
anything it has already written that doesn't follow them.

It sits between its two siblings: [`on-read-reminder`](../on-read-reminder/README.md)
nudges on reads, [`on-edit-block`](../on-edit-block/README.md) denies edits
outright, and this one allows the edit but makes the guide non-optional
afterwards. All three share the rules-file format.

## Problem

`on-edit-block`'s denial is the strongest hint available, and it's expensive.
The rejected call was a full `Write` — the whole file, paid for, thrown away —
and the retry pays for the file a second time. Worse, that price is charged
even when nothing was wrong: an agent that already knew the conventions writes
compliant code, gets denied anyway, and rewrites it — sometimes *differently*,
because a rejected attempt reads as a wrong attempt.

Most of the time the gap between what was written and what the guide asks for
is a few lines. Patching those lines costs a fraction of a rewrite.

## Solution

Register a `PostToolUse` hook with a `Write|Edit|MultiEdit` matcher. After an
edit lands, the hook checks the target path against your rules. If the
required files haven't been read this session, it returns `additionalContext`
saying, in substance:

> You just edited `server/models/user.py`, which `on-edit-reminder.rules` ties
> to required reading: `docs/PYTHON-GUIDE.md`. The edit was allowed, not
> checked — nothing here says it complies. Read it now, with the Read tool,
> before your next edit. Then re-check `server/models/user.py` and every other
> file you have changed this session against it, and correct every violation
> you find immediately — do not defer the corrections to the end of the task,
> and do not report the work as done while one stands.

The "every other file you have changed this session" clause is the point.
Earlier edits made without the guide are exactly the ones at risk, and a
reminder that only covers the current file leaves them broken.

The reminder names the required files rather than inlining them — the whole
premise is that a targeted read plus a small patch beats a blocked write plus
a full rewrite, and `on-edit-block` already covers the case where the content
must be in front of the agent before a single line is written.

**A required file is reminded about until it is actually read**, unlike
`on-edit-block`, which fires once and then gets out of the way because its
denial forced the issue. Nothing forces the issue here, so silence after one
ignored reminder would make the tool pointless. To keep that from turning into
one reminder per edit, a file is re-reminded at most **once every two
minutes**; a burst of edits in one turn produces a single reminder. A file
counts as read when the session transcript shows a `Read` (or a Bash
`cat`/`more`/`less`/`head`/`tail`/`type`) of it. Deliveries live in a
per-session marker in the temp dir — no marker, no memory: sessions restart
clean.

Transcripts are written asynchronously, so a read from the *current* turn may
not be flushed yet; the two-minute floor absorbs that.

## The rules file: `.claude/on-edit-reminder.rules`

The installer drops a starter file (all comments) at
`.claude/on-edit-reminder.rules`. Identical format to the two siblings:

```
# <pattern> -> <file>[, <file>...]   require reading <file>(s) after the edit
# !<pattern>                         never remind for these paths

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

- Required files missing from disk are reported as a broken rule instead of
  being handed to the agent to read.
- Lines that don't parse are reported (and ignored) on the next edit.
- Both of those are config problems the agent can't fix, so unlike the reading
  requirement they are reported **once per session** and then stay quiet.
- Absolute paths outside the project root never match.

With a `--user` install, the hook also reads `~/.claude/on-edit-reminder.rules`
as *global* rules, applied before the project's own file (so project rules
have the last word).

## Choosing between this and `on-edit-block`

| | `on-edit-reminder` | `on-edit-block` |
|---|---|---|
| The edit | lands | denied, must be retried |
| Cost when the agent already complied | one reminder | a discarded write plus a rewrite |
| Cost when it didn't | a read plus a patch | a read plus a rewrite |
| Guarantee | the guide is read *after* the first edit | no unguided edit ever lands |
| Fits | conventions, style, naming — things you patch | invariants where a wrong file on disk is itself the problem |

Both can be installed at once; they use separate rules files, so put a path in
whichever one matches how bad an unguided edit to it would be.

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers the hook on the `PostToolUse` event with a `Write\|Edit\|MultiEdit` matcher |
| `.claude/hooks/on_edit_reminder_PostToolUse_hook.py` | Matches edit targets, scans the transcript for prior reads, emits the reminder |
| `.claude/on-edit-reminder.rules` | Your pattern → required-files mapping (starter file is all comments) |

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

1. Copy `hooks/on_edit_reminder_PostToolUse_hook.py` into `.claude/hooks/` in your repo.
2. Make it executable: `chmod +x .claude/hooks/on_edit_reminder_PostToolUse_hook.py`
3. Copy `on-edit-reminder.rules` into `.claude/` and write your rules.
4. Add (or merge) the following into your repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/on_edit_reminder_PostToolUse_hook.py"]
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
it: write a rule, ask the agent to edit a matching file. The edit goes
through, and the agent is told to read your file and correct what it just
wrote.

Requires a working Python 3 where the installer runs — its absolute path is
baked into the hook config, so the interpreter does not need to stay on PATH
afterwards. No other dependencies — the hook is stdlib-only.
