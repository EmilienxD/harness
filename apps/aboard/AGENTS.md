# AGENTS.md

## Project shape

Aboard is a VS Code extension for Claude Code and ChatGPT (Codex CLI). It provides visible Aboard-launched terminals, fleet and activity views, project scaffold management, lifecycle tracking, and Auto Run orchestration on either platform. Harness owns user-facing skills, hooks, session commands, and their persistent state.

The clean-slate redesign deliberately has no compatibility layer. Do not restore Manager, roadmap/TODO, MCP, custom agent definitions, report mailboxes, in-process child telemetry, `/queue`, or standalone PR review entry points.

## Retained session kinds

- `interactive`: an ordinary empty, user-controlled Claude Code or Codex TUI.
- `Explore`: a read-only exploration session; Claude Code's built-in agent, or a top-level Codex session held read-only by sandbox and approval policy.
- `implementer`: an Auto Run worker launched with `/implement`, or a top-level Codex session that invokes `$implement`.
- `reviewer`: an Auto Run worker launched with `/review-afk` or `/review-hitl`, or a top-level Codex session that invokes `$review-afk` or `$review-hitl`.

Aboard applies internal lifecycle and Auto Run completion hooks only. It never copies Harness assets into its scaffold or private runtime bundle.

## Sources of truth

- `temp/REFACTOR.md` defines this redesign's product boundary.
- Runtime code, focused tests, and scaffold assets define implementation behavior.
- `docs/configuration.md` defines user-facing settings.
- `docs/CLAUDE-REFERENCES/` defines Claude Code integration behavior.

## Key constraints

- Preserve Auto Run behavior except for custom-agent-to-skill worker launches.
- Aboard owns all Auto Run Git and GitHub mutations; workers leave changes uncommitted.
- `.abd/scaffold.json` is the initialized-project marker. With it absent, runtime surfaces are closed.
- Mutable runtime state belongs in VS Code storage, not the workspace.
- `.abd/launch.json` is the launch authority. Re-read it for new launches and resumes.
- Keep TypeScript strict and support Windows paths.

## Validation

From `apps/aboard/`:

```powershell
npm run check
npm test
npm run test:vscode
npm run package
```

Use the `tdd` skill before adding tests. Use `aboard-e2e` only for work under `e2e/`.
