# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

"harness" is a collection of installable Claude Code tools (skills, hooks, agents, packages, scripts),
primarily authored for Claude Code but intended to be portable to other agent CLIs later.

Each tool lives under `harness/<tool-name>/`. Its `README.md` (or `SKILL.md` if no README exists) is the
source of truth for what it does — this file only indexes them.

Tools are installed individually with `uvx --from git+https://github.com/EmilienxD/harness harness
install <tool>`, which copies files into the target project's `.claude/` and merges any settings the
tool needs. The CLI is in `src/harness_cli/`; see the root `README.md`.

## Adding or changing a tool

Every installable tool needs a `harness.toml` in its directory declaring `name`, `version`,
`description`, and one or more `[[files]]` entries (`src` relative to the tool dir, `dest` relative to
the target `.claude/`). Settings go in a sibling `settings.fragment.json` — plain JSON, merged as-is,
with `${PYTHON}` and `${CLAUDE_DIR}` resolved at install time. `${PYTHON}` becomes `uv run --no-project`
when `uv` is installed (which it is if you used `uvx`), otherwise falls back to the first working
interpreter among `python3`, `python`, `py` (the Windows Store alias passes `which` without being a
real interpreter, so actual execution is tested). A tool without a manifest is invisible to the
installer, so add one in the same change that adds the tool, and bump `version` whenever its files or
fragment change. Run `uv run pytest` — the suite installs every manifest for real and round-trips
uninstall.

## Tools

- `harness/caveman/` — ultra-compressed communication mode skill. See `SKILL.md`.
- `harness/commit/` — zero-model-call `/commit` hook. See `README.md`.
- `harness/create-skill/` — guide for authoring new Claude Skills. See `SKILL.md`.
- `harness/grill-me/` — interviews the user to stress-test a plan/design. See `SKILL.md`.
- `harness/handoff/` — compacts a conversation into a handoff doc for another agent. See `SKILL.md`.
- `harness/improve-codebase-architecture/` — finds architectural friction and proposes refactors. See
  `SKILL.md`.
- `harness/issues/` — one bundle for the whole issue workflow: `/draft-issue`, `/publish-issue`,
  `/map-issues`, `/draft-issues`, `/publish-issues`, `/to-spec`, `/to-spec-draft-issue`, plus the
  publishing hook. See `README.md`.
- `harness/on-edit-block/` — PreToolUse hook denying Write/Edit/MultiEdit on paths matching
  gitignore-style patterns until user-picked files have been read that session. Same rules-file UX as
  `on-read-reminder`. See `README.md`.
- `harness/on-read-reminder/` — PostToolUse hook reminding the agent to read user-picked files when it
  reads paths matching gitignore-style patterns. See `README.md`.
- `harness/prefer-read-tool/` — PostToolUse hook reminding the agent to use Read instead of cat/sed.
  See `README.md`.
- `harness/senior-advisor/` — read-only senior-developer advisory mode. See `SKILL.md`.
- `harness/usage-limit-wait/` — `UserPromptSubmit` + `PostToolBatch` hook that blocks the session
  until an exhausted Claude subscription usage window resets. See `README.md`.
- `harness/zoom-out/` — gives a higher-level map of a codebase area. See `SKILL.md`.
- `harness/itsclaudehistory/` — nested git repo; leave its internals alone unless asked.

## Other directories

- `docs/CLAUDE-REFERENCES/` — mirrored upstream Claude Code docs, refreshed by
  `scripts/update_claude_references.py` via the `update-claude-references.yml` workflow. Consult these
  for how Claude Code itself works (hooks, skills, settings, tools) rather than relying on prior
  knowledge.
