# AGENTS.md

## Mission

Build **aboard**: a VS Code extension that replaces opaque in-process delegation with visible, independent Claude Code terminals coordinated by a long-lived Manager. Preserve user visibility and judgement; aboard is an experience tool, not an autonomous software factory.

## Sources of truth

1. [`docs\initial-spec.md`](./docs\initial-spec.md) is the authoritative product and behavior contract.
2. [`docs/architecture.md`](./docs/architecture.md) is the accepted repository architecture.
3. [`docs/CLAUDE-REFERENCES/`](./docs/CLAUDE-REFERENCES/) contains the Claude Code documentation snapshots used by the spec. Verify hook, settings, tool, agent, and CLI behavior there before relying on memory.

If implementation convenience conflicts with a load-bearing decision in the spec, follow the spec. Do not silently reinterpret an open question; document it and ask the user when it blocks the requested work.

## Current stage

The repository is pre-implementation. Configuration and architecture documents exist, but there is intentionally no runtime source. Do not add placeholder classes or speculative abstractions merely to fill the planned directory tree.

## Architecture

- One npm package; no workspace or monorepo tooling.
- Strict TypeScript VS Code extension, bundled with esbuild to CommonJS.
- The authenticated HTTP/MCP bridge runs in-process in the extension host.
- Python hook assets run through `uv` and are shipped as scaffold templates.
- Prefer native VS Code and Node APIs. Add frameworks only for a demonstrated need.
- Keep domain state independent from VS Code, HTTP, subprocess, filesystem, clock, and GitHub CLI details.
- Parse and validate data at process, HTTP, MCP, hook, settings, and persisted-file boundaries.

Follow the intended module layout in `docs/architecture.md`, but create a directory only when adding its first real file.

## Non-negotiable product invariants

- The bridge is the only creator of aboard agents. Hand-started Claude sessions are outside the system.
- Bind bridge networking to `127.0.0.1` only and require a per-activation bearer token on every request.
- Never commit bridge tokens, session data, prompts, or other `.aboard/runtime/` contents.
- At most one write-capable agent holds the write lease. Derive write capability from the effective tool set; do not maintain a second manual flag.
- The Manager orchestrates and does not implement. Its allowed tools must not include Claude Code's `Agent` tool or session-task tools.
- Every project-scoped hook must first self-guard on `ABOARD_AGENT_ID`; hooks for specific roles must also check `ABOARD_AGENT_TYPE`. A non-addressed hook exits `0` silently.
- aboard may add hook registrations to `.claude/settings.json`, but must preserve user settings and must never write `permissions` or `autoCompact`.
- Resolve worker prompts before launch. Pass the first prompt as a CLI argument; never type an automated worker's prompt into a live TUI.
- Treat `--agent` as mutually exclusive with Manager-style `--tools`/system-prompt launch configuration.
- GitHub is the durable work-state source. Do not introduce `TODO.md` or duplicate issue/PR state locally.
- Preserve the four-label model from the spec: `spec`, `todo`, `afk`, and `hitl`. Derive other state.
- Automated review remains opt-in.
- `raw` is the absence of an agent definition. Do not create a raw-agent prompt file.

## Skills and scaffold assets

aboard owns only the `update-todo` and `brainstorm` skills. The user-owned `map-issues`, `draft-issues`, `publish-issues`, `grill-me`, `lavish`, and `commit` skills must not be implemented or rewritten here.

When those user-owned skills are packaged, vendor them as build assets from their upstream repository. Never use git submodules and never edit a vendored copy in place. Report a missing upstream asset instead of inventing a replacement.

The extension owns scaffolded files, versions them, upgrades unchanged files, and warns instead of clobbering locally edited files.

## Development conventions

- Use Node.js 24 and npm 11 for local tooling. Keep bundled output compatible with Node.js 22.
- Keep TypeScript strict. Avoid `any`; use `unknown` plus validation at untrusted boundaries.
- Model protocol messages, failures, agent types, and lifecycle states explicitly. Prefer discriminated unions over boolean combinations.
- Keep functions and modules focused. Avoid global mutable state outside the extension composition root.
- Make lifecycle cleanup explicit: dispose VS Code registrations, close servers, stop polls, and release resources on deactivation.
- Support Windows paths and PowerShell as first-class environments. Do not assume POSIX shell syntax or `/tmp`.
- Do not log bearer tokens, full secret-bearing environments, or sensitive prompt contents.
- Use comments to explain invariants and non-obvious tradeoffs, not to narrate straightforward code.

## Verification

After runtime source exists, the baseline commands are:

```powershell
npm run check
npm run build
npm run package
```

Add focused tests with each behavior change. At minimum, cover:

- write-lease acquisition, refusal, release, and stale recovery;
- hook guards for non-aboard sessions and wrong agent types;
- authentication and loopback binding;
- prompt resolution and command argument construction;
- settings/scaffold merge behavior that preserves user configuration;
- session resume and typed failure transitions.

For Python hooks, test both stdin payloads and inherited `ABOARD_*` environment variables. A guard-path test must assert exit `0` with no stdout or stderr.

## Change workflow

Before implementing a feature, read the relevant spec sections and the matching Claude reference documents. Keep changes scoped to one behavior, update architecture or product documentation when a decision changes, and run the narrowest relevant checks plus the baseline checks before handing off.

Do not modify `.claude/settings.json` as repository cleanup. It contains user-level project preferences; implementation of the scaffolder must merge only its hook registrations non-destructively.
