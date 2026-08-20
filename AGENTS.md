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
`description`, and one or more `[[files]]` entries (`src` relative to the tool dir and `dest` relative
to its logical destination root). Claude Code settings default to a sibling `settings.fragment.json`;
platform-specific native JSON fragments are named by `[platforms.<name>].fragment`. They are merged
as-is, with `${PYTHON}` and platform placeholders resolved at install time. `${PYTHON}` becomes
`uv run --no-project`
when `uv` is installed (which it is if you used `uvx`), otherwise falls back to the first working
interpreter among `python3`, `python`, `py` (the Windows Store alias passes `which` without being a
real interpreter, so actual execution is tested). A file the user is meant to edit after install —
config templates, like the `.rules` files — declares `starter = true` on its `[[files]]` entry: it is
copied when absent and never overwritten afterwards. A tool without a manifest is invisible to the
installer, so add one in the same change that adds the tool, and bump `version` whenever its files or
fragment change. Run `uv run pytest` — the suite installs every manifest for real and round-trips
uninstall.

A fragment is merged as written: the installer adds the entries a tool declares and removes them
again on uninstall, and it does not rewrite hook entries belonging to anyone else. Changing a hook's
`matcher` is safe — hook groups merge by matcher, so the installer moves an existing install's entry
out of the old group rather than leaving both firing. Keys that Claude
Code's settings schema doesn't define don't belong in a fragment either — project settings are
validated strictly, and a file that fails validation is rejected whole.

The installer has explicit `claude` and `chatgpt` platform adapters. Commands default to Claude Code
for backward compatibility and select ChatGPT with `--platform chatgpt`. A legacy manifest implicitly
supports Claude Code only. New target support belongs in `[platforms.<name>]` with a `supported`,
`replacement`, or `unsupported` status and, for native config, a target-specific `fragment`. File
entries can use `root = "platform"`, `"skills"`, or `"hooks"`; omit `platforms` for a shared payload or
set `platforms = ["chatgpt"]` (or `"claude"`) for a variant. The adapter maps those roots to `.claude`,
`.agents`, and `.codex`; do not put platform-path conditionals in installer call sites. Legacy
Claude-relative `dest` entries and `settings.fragment.json` remain supported unchanged.

## Tools

- `harness/audit/` — audits a codebase and reports evidence-backed findings. See `SKILL.md`.
- `harness/caveman/` — ultra-compressed communication mode skill. See `SKILL.md`.
- `harness/commit/` — zero-model-call `/commit` hook. See `README.md`.
- `harness/create-skill/` — guide for authoring new Claude Skills. See `SKILL.md`.
- `harness/grill-me/` — interviews the user to stress-test a plan/design. See `SKILL.md`.
- `harness/handoff/` — compacts a conversation into a handoff doc for another agent. See `SKILL.md`.
- `harness/improve-codebase-architecture/` — finds architectural friction and proposes refactors. See
  `SKILL.md`.
- `harness/issues/` — one bundle for the whole issue workflow: `/draft-issue`, `/publish-issue`,
  `/draft-issues`, `/publish-issues`, `/to-spec`, `/to-spec-draft-issue`, plus the
  publishing hook. See `README.md`.
- `harness/on-edit-block/` — PreToolUse hook denying Write/Edit/MultiEdit on paths matching
  gitignore-style patterns until user-picked files have been read that session. Same rules-file UX as
  `on-read-reminder`. See `README.md`.
- `harness/on-edit-reminder/` — PostToolUse hook that lets the edit land, then makes the agent read
  the user-picked files and fix what already violates them. Same rules-file UX as `on-edit-block`,
  weaker and cheaper. See `README.md`.
- `harness/on-read-reminder/` — PostToolUse hook reminding the agent to read user-picked files when it
  reads paths matching gitignore-style patterns. See `README.md`.
- `harness/prefer-edit-tool/` — PostToolUse/PostToolUseFailure hook reminding the agent to use
  Write/Edit instead of heredocs, `>` redirects, `sed -i`, inline python `open(...)` and PowerShell
  `Set-Content`. Write-side counterpart to `prefer-read-tool`. See `README.md`.
- `harness/prefer-read-tool/` — PostToolUse hook reminding the agent to use Read instead of cat/sed.
  See `README.md`.
- `harness/redirect-subagents/` — PreToolUse/PostToolUse/Stop hooks redirecting Agent subagents
  to alternate providers (clauder, `claude -p`, custom CLIs) instead of consuming the Claude
  subscription. Config in `.claude/harness/subagents.json`. See `README.md`.
- `harness/senior-advisor/` — read-only senior-developer advisory mode. See `SKILL.md`.
- `harness/usage-limit-wait/` — `UserPromptSubmit` + `PostToolBatch` hook that warns as a Claude
  subscription usage window fills and blocks the session until it resets. See `README.md`.
- `harness/zoom-out/` — gives a higher-level map of a codebase area. See `SKILL.md`.
- `harness/itsclaudehistory/` — nested git repo; leave its internals alone unless asked.

## Other directories

- `docs/CLAUDE-REFERENCES/` — mirrored upstream Claude Code docs, refreshed by
  `scripts/update_references.py` via the `update-references.yml` workflow. Consult these
  for how Claude Code itself works (hooks, skills, settings, tools) rather than relying on prior
  knowledge.
- `docs/CHATGPT-REFERENCES/` — mirrored official ChatGPT developer docs, refreshed by the same
  script and workflow. Upstream still uses `codex` and `.codex` for some CLI implementation
  identifiers; use ChatGPT as the product name in harness-authored material.
- `docs/CHATGPT-COMPATIBILITY.md` — current feasibility map and implementation plan for a native
  ChatGPT target.
