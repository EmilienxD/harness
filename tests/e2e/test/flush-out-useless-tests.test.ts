import assert from "node:assert/strict";
import test from "node:test";
import { runFlushOutUselessTestsJourney } from "../tools/flush-out-useless-tests/run.js";

for (const [scope, mode] of [["project", "json"], ["project", "rpc"], ["user", "rpc"]] as const) {
  test(`actual Harness install and real Pi ${scope}/${mode} audit passing tests before approved cleanup`, { timeout: 120_000 }, async () => {
    const result = await runFlushOutUselessTestsJourney(scope, mode);
    assert.equal(result.unchangedBeforeApproval, true);
    assert.equal(result.noReportFile, true);
    assert.equal(result.baselineCounts, 2);
    assert.equal(result.inferenceRequests, 7);
    assert.equal(result.unexpectedRequests, 0);
    assert.equal(result.removed, true);
    assert.equal(result.chatgptPreserved, true);
    assert.equal(result.settingsPreserved, true);
    assert.deepEqual(result.checkpoints, ["passing-baseline", "read-production", "read-tests", "awaiting-approval", "approved-cleanup", "verified-cleanup", "complete"]);
  });
}
