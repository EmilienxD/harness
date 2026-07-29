# aboard

aboard is a planned VS Code extension that runs delegated Claude Code work in visible, independent terminals while a long-lived Manager coordinates the fleet. GitHub is the durable work-state backbone, and the user remains in control of decisions that matter.

The project is currently pre-implementation. The product contract is [spec.md](./spec.md), and the accepted implementation shape is [docs/architecture.md](./docs/architecture.md).

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

There is intentionally no runtime source yet. Once `src/extension.ts` exists, use `npm run check`, `npm run build`, and `npm run package`.
