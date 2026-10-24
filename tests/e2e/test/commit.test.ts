import test from "node:test";
import { runCommitJourney } from "../tools/commit/run.js";
import { runCodexCommitContextJourney, type ContextMode } from "../tools/commit/codex-run.js";
test("commit hook commits the real CLI edit without another inference request", { timeout: 180000 }, runCommitJourney);

for (const mode of ["healthy", "storage-failure", "lookup-failure"] satisfies ContextMode[]) {
  test(`Codex commit context allows ordinary Unicode prompts: ${mode}`, { timeout: 60_000 }, async () => {
    await runCodexCommitContextJourney(mode);
  });
}
