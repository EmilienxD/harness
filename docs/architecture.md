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
- Scaffold templates are assets, not runtime source. Vendored user-owned skills are copied from upstream and never edited in place.
- Persistent project state belongs in GitHub or committed files. Ephemeral live state belongs under `.aboard/runtime/`; the bridge token file lives outside the workspace entirely (see resolved decisions).

## Resolved decisions from end-to-end testing (2026-07-30)

- **MCP tool naming:** the bridge serves bare tool names (`run_agent`, `list_agents`, …). Claude Code namespaces them for the model as `mcp__aboard__<name>`, so the spec's `aboard__*` delegation surface is realized as `mcp__aboard__*`, which is also what the Manager `--tools` presets allow.
- **Tool-list flags:** `--tools`/`--disallowedTools` take one comma-separated argument (`claude --help`: `"Bash,Edit,Read"`). The flags are variadic; spreading values across arguments lets the last one swallow the positional launch prompt.
- **Session resume:** `claude --resume <id>` fails on a session that was closed before its first message because no transcript exists yet. Resume paths (Manager, `send_to_agent`) probe for the transcript first and, when absent, start the conversation afresh under the same imposed `--session-id`.
- **Bridge discovery file location:** `bridge.json` moves out of the workspace into the extension's per-workspace storage (`ExtensionContext.storageUri`). Spec §5.2 places it in `.aboard/runtime/` "for hook scripts to read", but no hook reads it: hooks and the MCP client receive the port and token through the inherited `ABOARD_BRIDGE_PORT`/`ABOARD_BRIDGE_TOKEN` environment variables. Keeping it in the project only put a bearer-token file in the user's tree and made `.aboard/` exist before initialization, which broke the initialize-versus-update signal. `.vscode/` was rejected because it is routinely committed.
- **MCP approval:** `enabledMcpjsonServers: ["aboard"]` is written to `.claude/settings.local.json`, not `.claude/settings.json`. Claude Code honors the key in an untrusted folder only from a settings file that is not checked into the repository, so the scaffolder also adds that file to `.gitignore`.
- **Initialization state:** the presence of the `.aboard/scaffold.json` manifest is the single signal for "this project is initialized". It drives the `aboard.initialized` context key, which selects the welcome view and the Initialize/Update command pair. Deleting `.aboard/` discards the live session: terminals close, the lease is released, and the fleet is cleared.
- **Fleet tree surface (narrowed from spec §11):** a click focuses the terminal and the context menu offers focus and kill only. Send message is dropped — automated prompt delivery belongs in launch arguments, and a human takeover is better done by typing in the terminal that is already visible. Resume agent was a duplicate of focus that threw on the closed terminals it was meant for. Force-release-lease survives as a Command Palette entry only: it is the sole recovery from a lease stranded by an agent that died without releasing it. Telemetry (tokens, tool uses, compactions) is not rendered in the tree until it has a source that is actually wired up.
- **Dead agents:** `reportsResult` decides. The Manager and interactive agents report nothing — the Python hook guard keeps `/hooks/stop` to `implementer`, `reviewer`, and `fixer` — so a closed terminal removes them from the fleet and releases their write lease. Only automated workers with a waiting caller go through `WorkerLifecycleReconciler` and stay listed.
- **Agent type is bound to the launch tool:** `run_agent` and `spawn_agent` accept automated types only; `spawn_interactive_agent` accepts interactive types only, enforced in both the published JSON schema and the request parser. Launching an interactive type through a result-delivering tool would strand the caller on a result that its own hook guard prevents from ever arriving.
- **Panel layout:** three views in the activity-bar container, gated so the panel always reads as one design. `aboard.welcome` (`!aboard.initialized`) carries the presentation and Initialize. Once initialized it is replaced by `aboard.manager` above `aboard.fleet`. The Manager section renders at most one row and, because VS Code shows welcome content only on an empty tree, automatically falls back to Resume/New when no Manager is running — no context key needed for that. Workers therefore cannot share the Manager's tree: they would suppress the launch actions merely by existing, and a fleet without a Manager is a valid state. `aboard.managerResumable` decides whether Resume appears above New.
- **Tree icons:** `organization` for the Manager, `comment-discussion` for interactive agents, `lock` for automated workers, `symbol-method` for `Agent` children. The icon encodes whether the user may talk to the agent, not who holds the write lease; the lease stays in the row description.

## Testing strategy

- Unit-test lease, fleet, session, prompt, and failure state transitions as pure TypeScript.
- Test HTTP/MCP handlers with injected boundary adapters before using a real VS Code host.
- Test Python hooks as standalone stdin/environment programs, including the mandatory no-op guard path.
- Keep a small VS Code integration suite for activation, terminal creation, and native UI wiring.
- Add end-to-end tests only for the load-bearing workflows in the spec; avoid replacing human-visible acceptance testing with broad automation.

## Deferred choices

No UI framework, database, monorepo tool, dependency-injection framework, or general web server framework is selected. Native Node and VS Code APIs are the default until complexity demonstrates a concrete need.
