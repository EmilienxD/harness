import assert from "node:assert/strict";
import test from "node:test";

import { runPreferFewerCommentsJourney } from "../tools/prefer-fewer-comments/run.js";
import { TARGET_CONTENT } from "../tools/prefer-fewer-comments/scenario.js";

for (const platform of ["claude", "chatgpt"] as const) {
  test(`prefer-fewer-comments lets the real ${platform} CLI write and returns the comment-budget reminder`, async () => {
    const result = await runPreferFewerCommentsJourney(platform);
    assert.deepEqual(result.checkpoints, ["comment-heavy-write", "complete"]);
    assert.equal(result.targetContent, TARGET_CONTENT);
    assert.equal(result.unexpectedRequests, 0);
  });
}
