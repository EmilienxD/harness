import assert from "node:assert/strict";
import test from "node:test";

import { runOnEditReminderJourney } from "../tools/on-edit-reminder/run.js";

test("on-edit-reminder lets the real Claude edit land, then drives the required read and correction", async () => {
  const result = await runOnEditReminderJourney();
  assert.deepEqual(result.checkpoints, ["read-target", "edit-landed", "read-guide", "corrected", "complete"]);
  assert.equal(result.targetContent, "compliant value\n");
  assert.equal(result.unexpectedRequests, 0);
});
