import assert from "node:assert/strict";
import test from "node:test";

import { runPreferReadToolJourney } from "../tools/prefer-read-tool/run.js";

test("prefer-read-tool lets the real Claude shell read complete and returns the native-read nudge", async () => {
  const result = await runPreferReadToolJourney();
  assert.deepEqual(result.checkpoints, ["shell-read", "complete"]);
  assert.equal(result.targetContent, "content read through the shell\n");
  assert.equal(result.unexpectedRequests, 0);
});
