# harness

A collection of installable Claude Code tools — skills, hooks, agents — each one
independently installable into any project with a single command.

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install commit
```

That copies the tool's files into `./.claude/` and merges the settings it needs
into `./.claude/settings.json`, without disturbing anything already there.

## Usage

```bash
harness list                      # available tools, and what's installed here
harness info commit               # exactly what a tool will write
harness install commit --dry  # file list + a settings.json diff, nothing written
harness install caveman zoom-out  # several at once ('all' installs everything)
harness uninstall commit          # removes only what it added ('all' too)
harness upgrade                   # reinstall everything at the shipped version
```

Shorten the command by aliasing it, since the `--from` prefix is the same every time:

```bash
alias harness='uvx --from git+https://github.com/EmilienxD/harness harness'
```

Pin a version with `git+https://github.com/EmilienxD/harness@v0.1.0`.

### Scope: this project, or the whole machine

Every command takes the same two scopes. **Project scope is the default** — the
tool lands in the project you're standing in, and can be committed so your
whole team gets it.

```bash
harness install commit                # this project:  ./.claude/
harness install commit --user         # every project: ~/.claude/
```

`--global` is an alias for `--user` if that reads better. Both scopes are
independent: the same tool can be installed in both, and uninstalling from one
leaves the other alone.

| Flag | Effect |
|---|---|
| `--dir PATH` | project scope, but some project other than the cwd |
| `--user`, `--global` | machine-wide `~/.claude/`, active in every project |
| `--local` | write to `settings.local.json` (gitignored) — project scope only |

Hook paths adapt to the scope automatically: a project install writes Claude
Code's `${CLAUDE_PROJECT_DIR}` placeholder, while a machine-wide install writes
an absolute path, since `${CLAUDE_PROJECT_DIR}` would otherwise point at
whichever project happens to be open rather than at the hook.

`--user` rejects `--dir` and `--local` rather than quietly ignoring them —
Claude Code reads only `settings.json` at the user level, and `--dir` names a
project.

Restart Claude Code after installing so it picks up new hooks and skills.

## Tools

| Tool | What it does |
|---|---|
| [`caveman`](harness/caveman/SKILL.md) | Ultra-compressed communication mode |
| [`commit`](harness/commit/README.md) | `/commit` that stages and commits with zero model calls |
| [`create-skill`](harness/create-skill/SKILL.md) | Guide for authoring new Claude Skills |
| [`grill-me`](harness/grill-me/SKILL.md) | Interviews you to stress-test a plan or design |
| [`handoff`](harness/handoff/SKILL.md) | Compacts a conversation into a handoff doc |
| [`improve-codebase-architecture`](harness/improve-codebase-architecture/SKILL.md) | Finds architectural friction, proposes refactors |
| [`issues`](harness/issues/README.md) | Draft, spec and publish reviewed GitHub issues — one or a whole plan |
| [`on-edit-block`](harness/on-edit-block/README.md) | Blocks edits to protected files until Claude reads the required files |
| [`on-edit-reminder`](harness/on-edit-reminder/README.md) | Lets edits land, then makes Claude read the required files and fix what breaks them |
| [`on-read-reminder`](harness/on-read-reminder/README.md) | Reminds Claude to read your key files when it reads matching paths |
| [`prefer-edit-tool`](harness/prefer-edit-tool/README.md) | Nudges Claude to use Write/Edit instead of heredocs, `>`, `sed -i` or inline `python` |
| [`prefer-read-tool`](harness/prefer-read-tool/README.md) | Nudges Claude to use Read instead of `cat`/`sed` |
| [`redirect-subagents`](harness/redirect-subagents/README.md) | Redirects Agent subagents to alternate providers, sparing subscription usage |
| [`senior-advisor`](harness/senior-advisor/SKILL.md) | Read-only senior-developer advisory mode |
| [`usage-limit-wait`](harness/usage-limit-wait/README.md) | Warns as a subscription usage limit fills, then waits it out instead of failing the turn |
| [`zoom-out`](harness/zoom-out/SKILL.md) | Higher-level map of a codebase area |

Skill-only tools are just a `SKILL.md` — if you'd rather not use the installer,
copying that file to `.claude/skills/<name>/SKILL.md` yourself is the whole
installation.

## How installing works

Nothing is done by inference. Each tool declares what it installs in a
`harness.toml` next to its files:

```toml
name = "commit"
version = "1.0.0"
description = "Zero-model-call /commit"
requires = ["git"]
gitignore = ["commit-ai.key"]                      # also relative to .claude/

[[files]]
src = "hooks/commit_UserPromptSubmit_hook.py"
dest = "hooks/commit_UserPromptSubmit_hook.py"     # relative to .claude/
executable = true

[[files]]
src = "skills/commit"
dest = "skills/commit"
```

Settings live beside it in `settings.fragment.json` — real JSON, exactly what
gets merged, so it stays diffable against what Claude Code expects. Two
placeholders are resolved at install time: `${PYTHON}` becomes `uv run --no-project`
when `uv` is installed (which it is if you used `uvx`), otherwise falls back to
the first working interpreter among `python3`/`python`/`py`. `${CLAUDE_DIR}`
becomes `${CLAUDE_PROJECT_DIR}/.claude` (or an absolute path for `--user` installs).

A tool that stores a secret next to itself lists it under `gitignore`, and the
installer creates or extends the repo's root `.gitignore` accordingly. The
patterns go in a fenced `# >>> harness:<tool> >>>` block, because `.gitignore`
has no trailing-comment syntax — `commit-ai.key # harness` would make
`# harness` part of the pattern and silently stop matching. A pattern you
already had is left alone rather than duplicated, so uninstalling can't delete
a line you wrote.

**Installing leaves nothing behind but the tool's own files** — no lock file, no
`.bak`, no metadata directory. Everything `uninstall` needs is already in the
manifest, so there's no reason to write a second copy of it into your repo.
Which files belong to a tool comes from `[[files]]`; what it added to
`settings.json` comes from the fragment.

The merge is idempotent and reversible, which is the part that actually matters:

- Hook entries are identified by their command and arguments — the same rule
  Claude Code itself uses to deduplicate hooks — so reinstalling updates in
  place instead of appending a second copy that would run every hook twice.
- Your own hooks, permissions, and settings keys are never touched. Uninstall
  removes only entries that still match what was installed, and deletes
  `settings.json` only if it created it and nothing else is left in it.
- A file you've edited since installing is kept, not deleted, on uninstall —
  pass `--force` to remove it anyway.

## Development

```bash
uv run pytest              # merge semantics and install/uninstall round-trips
uv run harness list        # run the CLI from the checkout
```

The CLI lives in `src/harness_cli/`; the tool payload is the top-level
`harness/` directory, shipped inside the wheel as package data.
