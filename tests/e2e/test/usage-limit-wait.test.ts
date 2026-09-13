import assert from "node:assert/strict";
import test from "node:test";
import { runUsageLimitWaitJourney } from "../tools/usage-limit-wait/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  test(`usage-limit-wait pauses and resumes a real ${platform} turn from fake usage JSON`, async () => {
    const result = await runUsageLimitWaitJourney(platform);
    assert.deepEqual(result.checkpoints, ["usage-exhausted", "usage-restored", "complete"]);
    assert.equal(result.usageRequests, 2);
    assert.equal(result.unexpectedRequests, 0);
  });
}
