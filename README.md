# harness

A collection of installable agent tools — skills, hooks, agents — each one
independently installable into any project with a single command. The installer
targets both Claude Code and ChatGPT by default, with native payloads and paths
for each.

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install commit
```

That installs the tool's Claude Code payload under `./.claude/` and its ChatGPT
payload under `./.agents/` and `./.codex/`, without disturbing anything already
there.

## Usage

```bash
harness list                      # available tools, and what's installed here
harness info commit               # exactly what a tool will write
harness install commit --dry      # file lists + config diffs, nothing written
harness install caveman zoom-out  # several at once ('all' installs everything)
harness uninstall commit          # removes only what it added ('all' too)
harness upgrade                   # reinstall everything at the shipped version
harness install commit --platform claude  # install only for Claude Code
harness list --platform chatgpt            # inspect only the ChatGPT target
```

Every command targets both platforms when `--platform` is omitted. Pass the flag
once to select only one platform, or repeat it to select several explicitly:

```bash
harness install commit --platform chatgpt
harness install commit --platform claude --platform chatgpt
```

Mutating commands that name tools require them to support every selected
platform, and validate the whole selection before writing anything. `install
all` instead installs every tool supported by each selected platform and skips
unsupported/replacement-only tools for that platform.

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
harness install commit                # this project: both platforms
harness install commit --user         # every project: both platforms
harness install commit --platform claude  # this project: ./.claude/ only
```

`--global` is an alias for `--user` if that reads better. Both scopes are
independent: the same tool can be installed in both, and uninstalling from one
leaves the other alone.

| Flag | Effect |
|---|---|
| `--dir PATH` | project scope, but some project other than the cwd |
| `--user`, `--global` | machine-wide platform roots, active in every project |
| `--local` | write to `settings.local.json` (gitignored) — project scope only |

For ChatGPT, project skills go to `.agents/skills/` and native hook payloads
and `hooks.json` go under `.codex/`. User installs use the corresponding roots
in the home directory. `--local` is Claude Code-specific, so use it together
with `--platform claude`; it is rejected whenever ChatGPT is selected.

Hook paths adapt to the scope automatically: a project install writes Claude
Code's `${CLAUDE_PROJECT_DIR}` placeholder, while a machine-wide install writes
an absolute path, since `${CLAUDE_PROJECT_DIR}` would otherwise point at
whichever project happens to be open rather than at the hook.

`--user` rejects `--dir` and `--local` rather than quietly ignoring them —
Claude Code reads only `settings.json` at the user level, and `--dir` names a
project.

Restart the selected products after installing so they pick up new hooks and
skills.

## Tools

| Tool | What it does |
|---|---|
| [`audit`](harness/audit/claude/skills/audit/SKILL.md) | Audits a codebase and reports evidence-backed findings |
| [`caveman`](harness/caveman/shared/skills/caveman/SKILL.md) | Ultra-compressed communication mode |
| [`commit`](harness/commit/README.md) | `/commit` that stages and commits with zero model calls |
| [`create-skill`](harness/create-skill/claude/skills/create-skill/SKILL.md) | Guide for authoring new Claude Skills |
| [`grill-me`](harness/grill-me/shared/skills/grill-me/SKILL.md) | Interviews you to stress-test a plan or design |
| [`handoff`](harness/handoff/claude/skills/handoff/SKILL.md) | Compacts a conversation into a handoff doc |
| [`improve-codebase-architecture`](harness/improve-codebase-architecture/shared/skills/improve-codebase-architecture/SKILL.md) | Finds architectural friction, proposes refactors |
| [`issues`](harness/issues/README.md) | Draft, spec and publish reviewed GitHub issues — one or a whole plan |
| [`on-edit-block`](harness/on-edit-block/README.md) | Blocks edits to protected files until Claude reads the required files |
| [`on-edit-reminder`](harness/on-edit-reminder/README.md) | Lets edits land, then makes Claude read the required files and fix what breaks them |
| [`on-read-reminder`](harness/on-read-reminder/README.md) | Reminds Claude to read your key files when it reads matching paths |
| [`prefer-edit-tool`](harness/prefer-edit-tool/README.md) | Nudges Claude to use Write/Edit instead of heredocs, `>`, `sed -i` or inline `python` |
| [`prefer-read-tool`](harness/prefer-read-tool/README.md) | Nudges Claude to use Read instead of `cat`/`sed` |
| [`redirect-subagents`](harness/redirect-subagents/README.md) | Redirects Agent subagents to alternate providers, sparing subscription usage |
| [`senior-advisor`](harness/senior-advisor/shared/skills/senior-advisor/SKILL.md) | Read-only senior-developer advisory mode |
| [`usage-limit-wait`](harness/usage-limit-wait/README.md) | Warns as a subscription usage limit fills, then waits it out instead of failing the turn |
| [`zoom-out`](harness/zoom-out/shared/skills/zoom-out/SKILL.md) | Higher-level map of a codebase area |

Skill-only tools keep portable payloads under `shared/skills/` and only use
`claude/skills/` or `chatgpt/skills/` when behavior genuinely differs. If you'd
rather not use the installer, copy the shared skill or the appropriate product
variant to that product's skill directory.

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

That original form remains valid for legacy manifests. First-party tools use
explicit sibling payload layers and declare platform status and native fragments:

```toml
[platforms.claude]
status = "supported"
fragment = "claude/settings.fragment.json"

[platforms.chatgpt]
status = "supported" # or "replacement" / "unsupported"
fragment = "chatgpt/hooks.fragment.json"

[[files]]
src = "shared/skills/example/SKILL.md" # unchanged on every supported target
dest = "example/SKILL.md"
root = "skills"                 # .claude/skills or .agents/skills

[[files]]
src = "chatgpt/hooks/example.py"
dest = "example.py"
root = "hooks"                  # .claude/hooks or .codex/hooks
platforms = ["chatgpt"]
```

The logical roots are `platform` (the default: `.claude` or `.codex`),
`skills`, and `hooks`. A file entry without `platforms` is shared; an entry
with it is selected only for those targets. Existing manifests implicitly
support Claude Code and are unsupported on ChatGPT until they explicitly
declare a native implementation. A `replacement` declaration must name the
capability users should choose instead.

First-party fragments live inside their platform layer, such as
`claude/settings.fragment.json` and `chatgpt/hooks.fragment.json`; each target's
`fragment` declaration names its native JSON fragment. The JSON is merged as written, so it stays
diffable against what each product expects. `${PLATFORM_DIR}`, `${SKILLS_DIR}`,
and `${HOOKS_DIR}` are portable placeholders; ChatGPT resolves project paths
absolutely because it has no documented project-root placeholder. `${PYTHON}`
becomes `uv run --no-project --no-managed-python`
when `uv` is installed (which it is if you used `uvx`), otherwise falls back to
the first working interpreter among `python3`/`python`/`py`. `${CLAUDE_DIR}`
becomes `${CLAUDE_PROJECT_DIR}/.claude` (or an absolute path for `--user` installs).

A tool that stores a secret next to itself lists it under `gitignore`, and the
installer creates or extends the repo's root `.gitignore` accordingly. The
patterns go in platform-owned fenced blocks such as
`# >>> harness:<tool>:claude >>>` and
`# >>> harness:<tool>:chatgpt >>>`, because `.gitignore` has no trailing-comment
syntax — `commit-ai.key # harness` would make `# harness` part of the pattern
and silently stop matching. A pattern you already had is left alone rather than
duplicated, so uninstalling can't delete a line you wrote.

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

## ChatGPT support

The platform architecture is in place and many tools have native ChatGPT
equivalents. `list`, `info`, `install`, `uninstall`, and `upgrade` target both
platforms by default and accept repeatable `--platform` selections. They report
unsupported or replacement-only tools instead of copying incompatible Claude
payloads. Future ports can use shared skills alongside native
`.codex/hooks.json` fragments and target-specific payloads without adding
platform conditionals to the installer.
See
the [tool-by-tool compatibility assessment](docs/CHATGPT-COMPATIBILITY.md) and
the mirrored [official ChatGPT references](docs/CHATGPT-REFERENCES/README.md).
