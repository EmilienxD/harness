import assert from "node:assert/strict";
import { runPiSubagentsJourney } from "./run.js";

async function main() {
  for (const skill of ["none", "found", "missing"] as const) {
    const result = await runPiSubagentsJourney("auto", { pinnedRuntimes: false, skill });
    assert.equal(result.parentStatus, "success");
    assert.equal(result.request.state, skill === "missing" ? "failed" : "succeeded");
    assert.equal(result.childSessionSaved, skill !== "missing");
    assert.equal(result.inferenceRequests, skill === "missing" ? 4 : skill === "found" ? 6 : 5);
    assert.equal(result.unexpectedRequests, 0);
    assert.equal(result.requestFilesRemaining, 0);
    console.log(`subagents pi ${skill} E2E passed (${result.inferenceRequests} inference requests; upstream forbidden)`);
  }

}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
