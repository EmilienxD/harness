import assert from "node:assert/strict";
import test from "node:test";

import { runPreferEditToolJourney } from "../tools/prefer-edit-tool/run.js";

test("prefer-edit-tool lets the real Claude shell write land and returns the native-edit nudge", async () => {
  const result = await runPreferEditToolJourney();
  assert.deepEqual(result.checkpoints, ["shell-write", "complete"]);
  assert.equal(result.targetContent, "shell-created\n");
  assert.equal(result.unexpectedRequests, 0);
});
