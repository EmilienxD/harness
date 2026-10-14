import assert from "node:assert/strict";
import test from "node:test";
import { runPiTestWorkflowsJourney } from "../tools/pi-test-workflows/run.js";

for (const [scope, mode] of [["project", "json"], ["user", "rpc"]] as const) {
  test(`real Pi ${scope}/${mode} executes workflows before explicit confirmation and leaves failed runs stale`, { timeout: 180_000 }, async () => {
    const result = await runPiTestWorkflowsJourney(scope, mode);
    assert.equal(result.inferenceRequests, 13);
    assert.equal(result.unexpectedRequests, 0);
    assert.equal(result.confirmations, 1);
    assert.equal(result.toolExecutions, 12);
    assert.equal(result.expectedNonzeroTools, 5);
    assert.equal(result.installedCliRemoved, true);
    assert.equal(result.failedRunUnconfirmed, true);
    assert.deepEqual(result.checkpoints, [
      "initial-stale", "read-workflow", "passing-execution", "explicit-confirmation", "confirmed-passed",
      "broken-coverage", "invalid-format", "explicit-invalid-and-broken", "covered-regression",
      "changed-file-stale", "failed-execution", "failure-remains-stale", "complete",
    ]);
  });
}
