# prefer-fewer-comments

A `PostToolUse` hook that reads what a write *added* — a `Write`, an `Edit`, a
`MultiEdit`, ChatGPT's `apply_patch`, or a shell heredoc — and, when the added
text is carrying more commentary than the code needs, tells the agent to write
less of it from there on. The write itself always stands.

Works on Claude Code and ChatGPT from one script.

## Problem

Agents comment as they think. The result is code narrated line by line ("First
we take the list of users. Then we filter the inactive ones."), docstrings that
restate the signature in prose, and change explanations addressed to the
reviewer of *this* turn, left behind in a file that outlives the turn. None of
it survives contact with the next edit: the comment stays, the code moves, and
the file now lies. A file is read by people who can read code; what the code
can't say — the constraint, the trade-off, the bug this avoids — is worth a
line or two, and everything else belongs in the conversation, the commit
message, or a doc.

Saying so in `CLAUDE.md` mostly doesn't hold: the instruction is far away from
the moment of writing, and by mid-session it has been out-argued by the model's
own habit. A reminder attached to the tool result lands while the habit is
being exercised.

## Solution

The hook lexes the added text with the comment syntax for the file's language,
then checks each comment the write actually touched against a budget:

| Kind | Default budget | Why |
|---|---|---|
| Comment | 2 lines, 240 characters | Roughly two sentences: enough for a *why*, not for a narration |
| Docstring | 5 lines, 600 characters | A contract — what goes in, what comes out, what surprises the caller |
| File header | 15 lines, 1500 characters | A module's purpose has nowhere else to live |
| Density | 30% of added lines, for changes of 20+ lines | Catches many small comments, which no per-comment budget can |

Anything over budget produces `additionalContext` naming the file, the line,
and the first words of each offending comment, followed by the budget and —
on the first delivery of a session only — the reasoning. Later deliveries are
one line: the point was made once.

The reminder is explicitly forward-looking. It says *what you wrote stands;
write less next time*, because a turn spent rewriting comments that are merely
too long buys nothing, while the rest of the session is still unwritten.

### What it looks at

| Write path | Added text |
|---|---|
| `Write` | The whole content |
| `Edit` / `MultiEdit` | `new_string`, diffed against `old_string`, so untouched comments in the context aren't reported |
| `apply_patch` (ChatGPT) | The `+` lines, per file in the patch |
| `Bash` / `PowerShell` | A heredoc body, when the command redirects it to a file whose extension names a language |

Comments are found with a small lexer, not a line match, so a `#` in a URL, a
`//` inside a string, and a triple-quoted SQL constant are not comments.
Directives are outside the budget entirely: shebangs, `# type:`, `# noqa`,
`coding:`, `eslint-*`, `@ts-*`, `go:generate`, `nolint`, `region`, and friends
are addressed to a tool, not a reader.

Languages are recognised by extension — C-like, Python, hash-comment, `--`,
markup, and Lisp families cover most of a repo. An unknown extension is
skipped rather than guessed at, so a wrong guess can't invent findings.

### Repeat behaviour

One reminder per file every three minutes per session, recorded in a marker
file in the temp dir. A burst of edits in one turn is one reminder; an ignored
one comes back while the work is still moving.

## Configuration

`prefer-fewer-comments.rules`, installed next to the hook (`.claude/` or
`.codex/`), is optional and ships as pure comments — the defaults above apply
until you edit it. Two kinds of line are understood:

```
max-comment-lines = 3            # any of the budget keys, as key = number
docs/                            # gitignore-style pattern: exempt from budgets
vendor/**
!vendor/our-fork/**              # ...but this one is back under the budget
```

Budget keys: `max-comment-lines`, `max-comment-chars`, `max-doc-lines`,
`max-doc-chars`, `max-header-lines`, `max-header-chars`, `max-comment-ratio`,
`min-lines-for-ratio`.

Two locations are read, in order: the hook's own directory (where a `--user`
install keeps global rules) and the project's `.claude/` or `.codex/`, so
project rules have the last word. The file is a `starter`: installed when
absent, never overwritten by an upgrade.

If your repo's house style is heavier than the defaults — this one's is —
raise the budgets rather than uninstalling; the density check is the part that
catches real bloat.

## Components

| File | Purpose |
|---|---|
| `hooks/prefer_fewer_comments_PostToolUse_hook.py` | Extracts the added text, scans it, emits the reminder |
| `prefer-fewer-comments.rules` | Budget overrides and exempt paths |
| `.claude/settings.json` | Registers the hook on `PostToolUse` for `Write\|Edit\|MultiEdit\|Bash\|PowerShell` |
| `.codex/hooks.json` | Registers the same script for `Bash\|apply_patch` |

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

Pick the target platform in the menu, then select `prefer-fewer-comments`. See
the [repo README](../../README.md) for `--user`, `--local`, and removal.

Restart the agent so it picks up the hook, then test it: ask it to write a
four-line comment block into a `.py` file. The tool result should come back
with the reminder attached.

Requires a working Python 3 where the installer runs — its absolute path is
baked into the hook config, so the interpreter need not stay on PATH.
