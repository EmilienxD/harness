import assert from "node:assert/strict";
import test from "node:test";

import { runRedirectSubagentsJourney } from "../tools/redirect-subagents/run.js";

test("redirect-subagents replaces a native Agent call with a real Claude CLI child and returns its report", async () => {
  const result = await runRedirectSubagentsJourney();
  assert.deepEqual(result.checkpoints, [
    "parent-agent-request",
    "parent-waiting",
    "child-complete",
    "parent-received-report",
  ]);
  assert.equal(result.redirectedJobs, 1);
  assert.equal(result.deliveredJobs, 1);
  assert.equal(result.unexpectedRequests, 0);
});
