# Architecture

**Status:** Accepted  
**Date:** 2026-07-29

This document turns the product architecture in [`spec.md`](../spec.md) into a repository shape. The spec remains authoritative for behavior and invariants.

## Decision

aboard will be a single-package VS Code extension written in strict TypeScript and bundled to CommonJS with esbuild. The HTTP/MCP bridge runs in the extension host process so it shares the extension lifecycle and can call the VS Code terminal API directly. Project hook assets are Python scripts run with `uv`.

This is deliberately not a monorepo and not a separate bridge service. A second package or process should be introduced only when an observed deployment or isolation need justifies it.

## Runtime shape

The extension host owns four boundaries:

1. **Domain state:** fleet registry, write lease, session ledger, result mailboxes, and typed failures.
2. **Bridge:** loopback-only authenticated HTTP endpoints, the MCP tool surface, hook callbacks, and terminal control.
3. **Claude process integration:** prompt resolution, command construction, environment injection, lifecycle tracking, and resume behavior.
4. **VS Code integration:** activation, commands, TreeView, status bar, notifications, configuration, and terminal focus/control.

The bridge is the composition point, but protocol and state transitions should remain testable without VS Code. VS Code API calls, process launch, filesystem access, clocks, and GitHub CLI calls belong at boundaries rather than inside domain state.

## Intended repository layout

```text
src/
  extension.ts          extension activation and composition root
  domain/               fleet, lease, sessions, results, failures
  bridge/               HTTP, MCP, authentication, hook endpoints
  claude/               launch plans, prompts, terminals, resume
  vscode/               commands, views, status bar, notifications
  scaffold/             installation and upgrade of project assets
  shared/               small cross-boundary types and utilities
assets/scaffold/        versioned files copied into target projects
  .claude/agents/
  .claude/hooks/
  .claude/skills/
test/                   unit and boundary-focused integration tests
```

Folders should be created when their first real file is added; empty architectural placeholders are not needed.

## Dependency rules

- `domain` must not import `vscode`, HTTP server implementations, or process-launch APIs.
- Boundary modules may depend on domain contracts; domain code must not depend on boundary modules.
- Cross-boundary message shapes get explicit TypeScript types and runtime validation at untrusted inputs.
- Scaffold templates are assets, not runtime source. User-owned skills are not assets at all: each is installed by running its upstream install command, and aboard neither ships nor edits a copy.
- Persistent project state belongs in GitHub or committed files. Ephemeral live state belongs under `.aboard/runtime/`; the bridge token file lives outside the workspace entirely (see resolved decisions).

## Resolved decisions from end-to-end testing (2026-07-30)

- **MCP tool naming:** the bridge serves bare tool names (`run_agent`, `get_todo`, …). Claude Code namespaces them for the model as `mcp__aboard__<name>`, so the spec's `aboard__*` delegation surface is realized as `mcp__aboard__*`, which is also what the Manager's `tools:` frontmatter allows.
- **Manager launch shape:** the Manager runs as `--agent manager` with no tool flags. Its scaffolded definition declares the read-only `tools:` list like every other aboard agent — there is no runtime preset, and the persona stays out of the user's `CLAUDE.md`. aboard scaffolds no `CLAUDE.md` at all. (An earlier design launched the Manager as `--agent manager --tools <preset>` against a definition with no `tools:`; the launch-time `--tools` was removed so every agent's tool authority is its definition file.)
- **Builtin agent names launch as top-level sessions:** `--agent Explore` and `--agent general-purpose` work (verified), so Claude Code's builtin agents need no scaffolded definition of their own to be launchable through `run_agent`.
- **Command-line length is measured on the assembled line, not on the prompt.** `aboard.launch.maxInlinePromptChars` bounds the prompt text, but the shell's limit applies to the whole line — which also carries the wrapper command, any tool-list flags, and quoting that *expands* rather than preserves length (PowerShell doubles every `'`, Git Bash turns one into four characters). A prompt comfortably under the threshold could therefore still produce a line that `cmd.exe` refuses past 8191 characters, or that a console's line-editing buffer truncates before the shell ever parses it — and a truncated launch command fails silently or launches something subtly different from what was planned. `planLaunch` measures the built line against `MAX_COMMAND_LINE_CHARS` (cmd 8000, PowerShell and Git Bash 24000, all well below the 32767 `CreateProcess` ceiling), re-plans with the prompt spilled to `.aboard/runtime/prompts/<agentId>.md` and `@`-referenced when it is over, and raises a typed `command-line-too-long` when even that is not enough — which means the length is in the agent's own tool list and no prompt spill can help. Spilling is always safe, so an unsure path spills.
- **The inline launch shape carries no `--system-prompt`.** Spec §5.1.1 listed it as optional on the inline shape, but that shape's only user is `raw`, which §9.7 defines as the absence of an agent definition and therefore unconstrained: `workerConfigurations` returns a bare `{ shape: "inline" }` and nothing in the extension has ever produced a system prompt. It was reachable only from tests, and it put the one unbounded argument in the planner onto a command line that has to fit a shell's length limit. `--tools` stays on the shape because the `--agent` exclusion still has to reject it.
- **Tool-list flags:** `--tools`/`--disallowedTools` take one comma-separated argument (`claude --help`: `"Bash,Edit,Read"`). The flags are variadic; spreading values across arguments lets the last one swallow the positional launch prompt.
- **Session resume:** `claude --resume <id>` fails on a session that was closed before its first message because no transcript exists yet. The Manager resume path probes for the transcript first and, when absent, starts the conversation afresh under the same imposed `--session-id`.
- **Bridge discovery file location:** `bridge.json` moves out of the workspace into the extension's per-workspace storage (`ExtensionContext.storageUri`). Spec §5.2 places it in `.aboard/runtime/` "for hook scripts to read", but no hook reads it: hooks and the MCP client receive the port and token through the inherited `ABOARD_BRIDGE_PORT`/`ABOARD_BRIDGE_TOKEN` environment variables. Keeping it in the project only put a bearer-token file in the user's tree and made `.aboard/` exist before initialization, which broke the initialize-versus-update signal. `.vscode/` was rejected because it is routinely committed.
- **MCP approval:** `enabledMcpjsonServers: ["aboard"]` is written to `.claude/settings.local.json`, not `.claude/settings.json`. Claude Code honors the key in an untrusted folder only from a settings file that is not checked into the repository, so the scaffolder also adds that file to `.gitignore`.
- **Initialization state:** the presence of the `.aboard/scaffold.json` manifest is the single signal for "this project is initialized". It drives the `aboard.initialized` context key, which selects the welcome view and the Initialize/Update command pair. Deleting `.aboard/` discards the live session: terminals close, the lease is released, and the fleet is cleared.
- **Fleet tree surface (narrowed from spec §11):** a click focuses the terminal and the context menu offers focus and kill only. Send message is dropped — automated prompt delivery belongs in launch arguments, and a human takeover is better done by typing in the terminal that is already visible. Resume agent was a duplicate of focus that threw on the closed terminals it was meant for. Force-release-lease survives as a Command Palette entry only: it is the sole recovery from a lease stranded by an agent that died without releasing it. Telemetry (tokens, tool uses, compactions) is not rendered in the tree until it has a source that is actually wired up.
- **Dead agents:** `reportsResult` decides. The Manager and sessions handed to the user report nothing — the Python hook guard keeps `/hooks/stop` to the automated types (`implementer` and `pr-doctor-afk`, since `pr-doctor-hitl` is interactive) plus any session launched result-delivering (`ABOARD_DELIVERS_RESULT=1`, which is how the dual-mode builtin types report exactly when their launch asked for one) — so a closed terminal removes them from the fleet and releases their write lease. Only result-delivering workers go through `WorkerLifecycleReconciler` and stay listed.
- **One launch tool, two flags:** `run_agent` covers every launch shape through `interactive` (does a result exist at all?) and `run_in_background` (when does it arrive?), mirroring Claude Code's `Agent` tool so the Manager reuses a prior it already has. The former `spawn_agent` and `spawn_interactive_agent` were near-copies of the same description that the Manager selected between unreliably while paying for every shared instruction three times. Both flags survive because neither is derivable from the others: worker types are launchable in either mode, so only the caller knows which is meant.
- **Illegal launch combinations are coerced or rejected on whether they are ambiguous, not on whether they are wrong:** an interactive-only type without `interactive: true` has exactly one valid reading, so the bridge launches it interactively and returns a `notice` saying so — a rejection would only buy a round trip to the identical retry. An automated launch with no prompt has no valid reading and is rejected: the worker would sit at an empty TUI that nothing may type into. JSON Schema cannot express either rule conditionally, so `required` is `["type", "description"]` and the parser carries the rest.
- **Panel layout:** two views in the activity-bar container, gated so only one is ever visible. `aboard.welcome` (`!aboard.initialized`) carries the presentation and Initialize. Once initialized it is replaced by `aboard.fleet`, a single section holding the Manager — sorted first — and its workers. VS Code renders welcome content only on an empty tree, so the New/Resume buttons there cover the common empty case; because a fleet without a Manager is a valid state that fills the tree, the same two commands are also contributed to the view title menu under `!aboard.managerLive`, which is the real condition. `aboard.managerResumable` decides whether Resume appears at all, below New.
- **Configuration scopes:** aboard settings resolve through three layers, highest first: an explicit VS Code workspace or folder value (`.vscode/settings.json`), the checked-in project file `.aboard/settings.json`, then the user, profile, or contributed default value. Every contributed setting keeps window scope, so `.vscode/settings.json` already worked; `.aboard/settings.json` exists so a project can carry its aboard configuration next to the rest of its scaffolded state and share it with the team, without the extension writing into `.vscode/`. A developer's explicit VS Code workspace value deliberately outranks the shared file. The layering uses `WorkspaceConfiguration.inspect`, not `get`: `get` collapses every scope into one value, which would let the contributed default mask the project file. Project values are not validated separately — they flow through the same per-setting validation, so a bad value in either place produces the same diagnostic and the same fallback. The file is read by the extension host, watched on its own path (the `.aboard/**` scaffold watcher would reload it on every runtime write), and is never scaffolded: an empty override file is noise.
- **Tree icons:** `organization` for the Manager, `comment-discussion` for agents the user may talk to, `lock` for agents running to completion on their own, `symbol-method` for `Agent` children. Talk-to-able is per launch (`resultDelivery.mode === "none"` as well as the interactive-only types), not only per type, because the builtin types run either way. The icon never encodes the write lease; the lease stays in the row description.

## The auto-implementation loop (implemented)

[`auto-implementation.md`](./auto-implementation.md) is the contract; the loop lives in the extension, not in an agent.

- `src/domain/auto-run.ts` is a pure phase reducer: given a run record and observed repository facts it returns the next step or the terminal outcome. It reaches for no `vscode`, process, clock, or network.
- `src/auto/engine.ts` is the effectful driver. It owns the loop, performs every git and GitHub side effect through injected boundaries, emits notifications, and persists the run record to `.aboard/runtime/auto-run.json`.
- `src/git/client.ts` is the git boundary. The ad-hoc `execFile("git", …)` calls that were in `bridge/lifecycle.ts`, `bridge/worker-hooks.ts`, and the extension's briefing sources all run through it.
- `reviewer` and `fixer` are gone, replaced by `pr-doctor-afk` and `pr-doctor-hitl`, which review and fix in one context.

Two decisions in the implementation are worth recording because they are easy to re-derive incorrectly:

- **The reducer always walks from the first phase.** It never starts at the persisted phase. The observed repository decides where the run is, which makes resume and normal progress literally the same code path and honors "a record that disagrees with the repository loses". A persisted phase that is ahead of reality would otherwise stop the run on a pull request that was never opened.
- **A phase whose postcondition is indistinguishable from "not started" is checked by the driver, not the reducer.** The `implement` phase is the only such case: an agent that produced nothing leaves exactly the facts that selected it, so the reducer would relaunch it forever. The driver checks the working tree immediately after the agent finishes. A repeated-action guard in the driver backstops the same class of mistake for every other phase.

## Testing strategy

- Unit-test lease, fleet, session, prompt, and failure state transitions as pure TypeScript.
- Test HTTP/MCP handlers with injected boundary adapters before using a real VS Code host.
- Test Python hooks as standalone stdin/environment programs, including the mandatory no-op guard path.
- Keep a small VS Code integration suite for activation, terminal creation, and native UI wiring.
- Add end-to-end tests only for the load-bearing workflows in the spec; avoid replacing human-visible acceptance testing with broad automation.

## Deferred choices

No UI framework, database, monorepo tool, dependency-injection framework, or general web server framework is selected. Native Node and VS Code APIs are the default until complexity demonstrates a concrete need.
