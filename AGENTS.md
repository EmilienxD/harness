# AGENTS.md

## Mission

Build **aboard**: a VS Code extension that replaces opaque in-process delegation with visible, independent Claude Code terminals coordinated by a long-lived Manager. Preserve user visibility and judgement; aboard is an experience tool, not an autonomous software factory.

## Sources of truth

1. [`docs\initial-spec.md`](./docs\initial-spec.md) is the authoritative product and behavior contract.
2. [`docs/architecture.md`](./docs/architecture.md) is the accepted repository architecture.
3. [`docs/auto-implementation.md`](./docs/auto-implementation.md) is the authoritative contract for the automatic implementation workflow. Where it and the spec disagree, it wins — it explicitly supersedes spec §7.5, §9.3 steps 3–5, §9.5, and §9.6.
4. [`docs/CLAUDE-REFERENCES/`](./docs/CLAUDE-REFERENCES/) contains the Claude Code documentation snapshots used by the spec. Verify hook, settings, tool, agent, and CLI behavior there before relying on memory.

If implementation convenience conflicts with a load-bearing decision in the spec, follow the spec. Do not silently reinterpret an open question; document it and ask the user when it blocks the requested work.

## Current stage

Runtime source exists and the baseline checks under [Verification](#verification) apply. The automatic implementation workflow described in `docs/auto-implementation.md` is implemented: `src/domain/auto-run.ts` (pure reducer), `src/auto/engine.ts` (driver), and `src/git/client.ts` (git boundary). The `reviewer` and `fixer` agents are gone, replaced by `pr-doctor-afk` and `pr-doctor-hitl`.

Do not add placeholder classes or speculative abstractions merely to fill the planned directory tree. Create a directory when its first real file arrives.

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
- Every aboard agent takes its tool set from the `tools:` field of its `.claude/agents/<name>.md` definition. Launches never combine `--agent` with `--tools` — the planner rejects the pair, because the flag would compete with the frontmatter the write lease trusts. The Manager's read-only list lives in `.claude/agents/manager.md` like any other agent. The only surviving `--tools` flag is the optional restriction on a raw launch, which is the absence of a definition. `model:` and `effort:` are the opposite case: Claude Code honors them only for subagents, so aboard parses them from the definition and passes `--model`/`--effort` explicitly on every launch and resume — those flags carry the frontmatter rather than competing with it.
- aboard scaffolds no `CLAUDE.md`. That file belongs to the user's project and applies to every session in the workspace; the Manager persona lives in its agent definition.
- An agent definition's body is the agent's *entire* system prompt: `--agent` replaces Claude Code's default rather than adding to it. Every scaffolded definition therefore embeds the shared blocks in `docs/agent-prompts/` verbatim, and the code-writing agents also embed the engineering block. Edit the source file and propagate, never one copy.
- The Manager's session-start briefing inlines any fact it would otherwise spend a turn fetching — issue titles and dispositions, the roadmap body, auto-run state. There is no read tool for context the briefing already carries.
- GitHub is the durable work-state source. Do not introduce `TODO.md` or duplicate issue/PR state locally.
- Preserve the four-label model from the spec: `spec`, `todo`, `afk`, and `hitl`. Derive other state.
- Automated review remains opt-in.
- The extension owns the auto-implementation loop; agents only produce content. Every git and GitHub side effect — branch, commit, push, PR, merge — is performed by the extension, never by an agent. The `implementer` and pr-doctor definitions must forbid `git commit`, `git push`, and `gh`.
- The Manager cannot launch `implementer`, `pr-doctor-afk`, or `pr-doctor-hitl`. They are reachable only through the auto-run engine and `review_pr`.
- Every auto-run phase is idempotent and checks its own postcondition before acting. Resume correctness depends on it, and resume re-derives state from git and GitHub rather than trusting the persisted record.
- The extension never approves a pull request. GitHub refuses self-approval, so an `afk` PR is merged directly and a `hitl` PR waits for the user's merge, which spec §7.3 defines as the approval.
- `raw` is the absence of an agent definition. Do not create a raw-agent prompt file.

## Skills and scaffold assets

aboard owns only the `update-todo`, `brainstorm`, `raw`, `auto`, and `review-pr` skills. Each is a thin trigger for extension behavior and is meaningless outside aboard. The user-owned skills — the seven from the upstream `issues` tool (`map-issues`, `draft-issues`, `publish-issues`, `draft-issue`, `publish-issue`, `to-spec`, `to-spec-draft-issue`) plus `grill-me` and `commit` — must not be implemented or rewritten here.

Those skills are never shipped with the extension — no copy under `assets/`, no git submodule. Each is installed into a scaffolded project by running its upstream install command from the `VENDORED_SKILLS` table in `src/scaffold/project.ts`. Do not add a copy of one, and do not author a replacement for a skill whose command is missing or fails: report it.

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

The baseline commands are:

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
- session resume and typed failure transitions;
- auto-run phase transitions, postcondition short circuits, and resume from an interrupted run.

For Python hooks, test both stdin payloads and inherited `ABOARD_*` environment variables. A guard-path test must assert exit `0` with no stdout or stderr.

## Change workflow

Before implementing a feature, read the relevant spec sections and the matching Claude reference documents. Keep changes scoped to one behavior, update architecture or product documentation when a decision changes, and run the narrowest relevant checks plus the baseline checks before handing off.

Do not modify `.claude/settings.json` as repository cleanup. It contains user-level project preferences; implementation of the scaffolder must merge only its hook registrations non-destructively.
