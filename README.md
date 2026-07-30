# aboard

aboard is a VS Code extension that runs delegated Claude Code work in visible, independent terminals while a long-lived Manager coordinates the fleet. GitHub is the durable work-state backbone, and the user remains in control of decisions that matter.

The product contract is [docs/initial-spec.md](./docs/initial-spec.md), and the accepted implementation shape is [docs/architecture.md](./docs/architecture.md).

## Development baseline

- Node.js 24 for local tooling; extension output targets Node.js 22.
- npm 11.
- TypeScript bundled with esbuild.
- Python hooks executed with `uv`.
- VS Code 1.125 or newer.
- Claude Code, Git, and the GitHub CLI.

Install the pinned development dependencies with:

```powershell
npm install
```

## Verification

The local prerequisites are Node.js 24, npm 11, `uv`, and VS Code 1.125 or newer. The VS Code integration suite downloads VS Code 1.130 into `.vscode-test/` on first use.

```powershell
npm test                 # TypeScript unit and boundary integration tests, including Python hooks through uv
npm run test:vscode      # Activation, native command wiring, and terminal create/focus/close integration
npm run check
npm run build
npm run package          # Produces and inspects dist/aboard-0.0.0.vsix
```

`npm run package` fails if runtime code or required scaffold assets are absent, or if local `.aboard` state, environment files, tokens, session data, temporary prompts, tests, or source files would be included in the VSIX.
