# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

"harness" is a collection of installable Claude Code tools (skills, hooks, agents, packages, scripts),
primarily authored for Claude Code but intended to be portable to other agent CLIs later.

Each tool lives under `harness/<tool-name>/`. Its `README.md` (or `SKILL.md` if no README exists) is the
source of truth for what it does and how to install/use it — this file only indexes them.

## Tools

- `harness/caveman/` — ultra-compressed communication mode skill. See `SKILL.md`.
- `harness/commit/` — zero-model-call `/commit` hook. See `README.md`.
- `harness/create-skill/` — guide for authoring new Claude Skills. See `SKILL.md`.
- `harness/grill-me/` — interviews the user to stress-test a plan/design. See `SKILL.md`.
- `harness/handoff/` — compacts a conversation into a handoff doc for another agent. See `SKILL.md`.
- `harness/improve-codebase-architecture/` — finds architectural friction and proposes refactors. See
  `SKILL.md`.
- `harness/publish-issues/` — turns a plan into reviewed, dependency-linked GitHub issues. See
  `README.md`.
- `harness/senior-advisor/` — read-only senior-developer advisory mode. See `SKILL.md`.
- `harness/zoom-out/` — gives a higher-level map of a codebase area. See `SKILL.md`.
- `harness/itsclaudehistory/` — nested git repo; leave its internals alone unless asked.

## Other directories

- `docs/CLAUDE-REFERENCES/` — mirrored upstream Claude Code docs, refreshed by
  `scripts/update_claude_references.py` via the `update-claude-references.yml` workflow. Consult these
  for how Claude Code itself works (hooks, skills, settings, tools) rather than relying on prior
  knowledge.
