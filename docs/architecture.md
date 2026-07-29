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
- Persistent project state belongs in GitHub or committed files. Ephemeral secrets and live state belong only under `.aboard/runtime/`.

## Testing strategy

- Unit-test lease, fleet, session, prompt, and failure state transitions as pure TypeScript.
- Test HTTP/MCP handlers with injected boundary adapters before using a real VS Code host.
- Test Python hooks as standalone stdin/environment programs, including the mandatory no-op guard path.
- Keep a small VS Code integration suite for activation, terminal creation, and native UI wiring.
- Add end-to-end tests only for the load-bearing workflows in the spec; avoid replacing human-visible acceptance testing with broad automation.

## Deferred choices

No UI framework, database, monorepo tool, dependency-injection framework, or general web server framework is selected. Native Node and VS Code APIs are the default until complexity demonstrates a concrete need.
