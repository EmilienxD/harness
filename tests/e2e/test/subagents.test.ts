import assert from "node:assert/strict";
import test from "node:test";

import { runSubagentsJourney } from "../tools/subagents/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  test(`subagents delegates and explicitly replies through real ${platform} CLIs`, { timeout: 180_000 }, async () => {
    const result = await runSubagentsJourney(platform);
    assert.deepEqual(result.checkpoints, ["parent-request-write", "parent-waiting", "child-reply-armed", "child-complete", "parent-received-reply"]);
    assert.deepEqual(result.completedClis, ["child", "parent"]);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
}
