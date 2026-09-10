# Aboard E2E adapter

Aboard uses the repository-level Harness E2E core in `../../../tests/e2e/core/`.

This directory contains only Aboard-owned concerns: its disposable GitHub repository lifecycle, canonical fixture, Aboard scenario catalog, bridge/lifecycle journeys, Auto Run orchestration, and VS Code Extension Development Host runners. `server.ts` wires Aboard scenarios into the shared Anthropic transport; `smoke.ts` wires the Aboard fixture into the shared Claude launcher. Codex protocol scenarios remain here because they assert Aboard launch, lifecycle, guard, worker, and Auto Run behavior, while their CLI validation and isolated home configuration come from the shared core.

Run these commands from `apps/aboard/`:

```powershell
npm run check
npm test
npm run e2e:full
```
