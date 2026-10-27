import test from "node:test";
import { runCommitJourney } from "../tools/commit/run.js";
import { runCodexCommitContextJourney, type ContextMode } from "../tools/commit/codex-run.js";
for (const tool of ["Edit", "Write"] as const) {
  test(`Claude commit verifies native ${tool} without another inference request`, { timeout: 180000 }, async () => { await runCommitJourney(tool); });
}

for (const mode of ["healthy", "storage-failure", "lookup-failure", "verified"] satisfies ContextMode[]) {
  test(`Codex commit context and ownership: ${mode}`, { timeout: 60_000 }, async () => {
    await runCodexCommitContextJourney(mode);
  });
}
