import assert from "node:assert/strict";
import test from "node:test";

import { runOnEditBlockJourney } from "../tools/on-edit-block/run.js";

test("on-edit-block denies the first real Claude edit and permits its informed retry", async () => {
  const result = await runOnEditBlockJourney();
  assert.deepEqual(result.checkpoints, ["read-target", "edit-denied", "edit-retried", "complete"]);
  assert.equal(result.targetContent, "updated after reading the guide\n");
  assert.equal(result.unexpectedRequests, 0);
});
