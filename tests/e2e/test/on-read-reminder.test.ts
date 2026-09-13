import assert from "node:assert/strict";
import test from "node:test";

import { runOnReadReminderJourney } from "../tools/on-read-reminder/run.js";

test("on-read-reminder makes the real Claude CLI follow a matched read with the required read", async () => {
  const result = await runOnReadReminderJourney();
  assert.deepEqual(result.checkpoints, ["read-trigger", "read-required", "complete"]);
  assert.equal(result.finalText, "Required reading completed.");
  assert.equal(result.unexpectedRequests, 0);
});
