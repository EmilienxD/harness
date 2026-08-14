# Contributing

Thanks for looking. aboard is pre-1.0 and the fastest way to help is to use it on a real project and report where it got in your way.

## Before you write code

Read [`AGENTS.md`](./AGENTS.md) — it is the product, behavior, and architecture contract, and it is binding. Then read the relevant reference material:

- [`docs/configuration.md`](./docs/configuration.md) — every `aboard.*` setting and how the three config layers resolve.
- [`docs/CLAUDE-REFERENCES/`](./docs/CLAUDE-REFERENCES/) — Claude Code documentation snapshots. Verify hook, settings, tool, agent, and CLI behavior there rather than from memory.

If implementation convenience conflicts with a load-bearing decision in `AGENTS.md`, follow `AGENTS.md`. A change that reduces the user's visibility or removes a decision point is a regression no matter how much time it saves — open an issue and argue the decision instead of quietly reinterpreting it.

## Development baseline

- Node.js 24 for local tooling; extension output targets Node.js 22.
- npm 11.
- TypeScript, bundled with esbuild.
- Python hooks executed with [`uv`](https://docs.astral.sh/uv/).
- VS Code 1.125 or newer. The integration suite downloads VS Code 1.130 into `.vscode-test/` on first use.
- Claude Code, Git, and the GitHub CLI.

```powershell
npm install
```

Windows paths and PowerShell are first-class here. Do not assume a POSIX shell or `/tmp`.

## Verification

```powershell
npm test                 # TypeScript unit and boundary integration tests, including Python hooks through uv
npm run test:vscode      # Activation, native command wiring, and terminal create/focus/close integration
npm run check
npm run build
npm run package          # Produces and inspects dist/aboard-0.0.0.vsix
```

`npm run package` fails if runtime code or required scaffold assets are absent, or if local `.aboard` state, environment files, tokens, session data, temporary prompts, tests, or source files would be included in the VSIX.

Add focused tests with each behavior change. At minimum, cover write-lease transitions, hook guards for non-aboard sessions, bridge authentication and loopback binding, prompt resolution and command construction, scaffold merge behavior that preserves user configuration, session resume and typed failures, and auto-run phase transitions including resume from an interrupted run.

## Trying it safely

Do not run an end-to-end test inside this repository — it would create real issues and PRs and merge hooks into `.claude/settings.json`. Scaffold a throwaway repo instead; [`user-guide.md`](./user-guide.md) walks through a full sandbox run phase by phase.

## Scope notes

- aboard owns only the `update-todo`, `brainstorm`, `raw`, `auto`, and `review-pr` skills. The user-owned skills are installed from upstream and must not be reimplemented here.
- Never commit bridge tokens, session data, prompts, or anything else under `.aboard/runtime/`.
- Keep changes scoped to one behavior, and update the architecture or product docs when a decision changes.
