# aboard

Aboard is a VS Code extension for visible coding-agent sessions. It supports attended Claude Code and ChatGPT (Codex CLI) terminals, tracks their lifecycle in the Fleet and Recent Activity views, and orchestrates Auto Run.

## What Aboard does

- Initializes and validates the extension-owned `.abd` scaffold.
- Launches an empty **Run Agent** interactive TUI with the platform selected in `.harness/launch.json`.
- Launches a read-only Explore session when Auto Run needs pre-implementation exploration: Claude Code's built-in `Explore` agent, or a top-level Codex session held read-only by its sandbox and approval policy.
- Tracks Aboard-created sessions and supports resume/reopen with current launch configuration, including attended Codex conversations discovered through supported App Server operations.
- Runs the complete Auto Run forecast, execution, recovery, validation, Git, and GitHub workflow.

Aboard tracks Interactive, Explore, Prototype, Web Search, Brainstorm, General, Auto Run implementer, and Auto Run reviewer identities. Execution mode is recorded separately, so an unattended manual child is not treated as an Auto Run worker. Claude Interactive, implementer, and reviewer sessions deny `Agent`, `WebSearch`, and `WebFetch` by default through `.harness/launch.json`; users can change these profile denials. ChatGPT workers get the same boundary through Codex's own settings: web search disabled, multi-agent tools off, and a `PreToolUse` guard that denies Aboard-owned Git and GitHub commands. In worktree mode, a native Codex permission profile also makes the user's original checkout read-only; this requires Codex 0.138.0 or later and fails closed when managed policy disallows the profile.

## Auto Run

`/auto` starts Auto Run immediately and `/auto --dry` produces a forecast. The panel offers a separate review-and-start path. Aboard owns all Auto Run Git and GitHub mutations. Workers receive complete issue or pull-request context through the Harness-installed `/address-issue` and `/issue-review` skills, and signal completion by committing on the branch Aboard put them on. Aboard grants them `git add` and `git commit` and keeps every other Git and GitHub operation to itself.

Auto Run continues to support issue dispositions, difficulty routing, optional Explore sessions, per-issue and single-branch modes, worktrees, review, recovery, cancellation, and run activity.

## Harness boundary

Harness is the canonical catalogue and installer for skills, user-facing hooks, and the `harness run`, `ask`, `reply`, and `resume` commands. Aboard does not package, scaffold, copy, inspect, or transform Harness-owned skill or hook bodies.

Aboard does not provide a Manager role, roadmap/TODO workflow, MCP server, custom agent definitions, `/queue`, or standalone PR review. The dormant queue and standalone review implementations may remain compiled but have no command, panel, menu, hook, or MCP entry point.

## Development

```powershell
npm install
npm run check
npm test
npm run test:vscode
npm run package
```

See `AGENTS.md` for the project map and architectural boundaries, and
[`docs/configuration.md`](docs/configuration.md) for the version-2 launch file.
