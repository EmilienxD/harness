import assert from "node:assert/strict";
import test from "node:test";

import { runIssueWritersJourney } from "../tools/issue-writers/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  const cliName = platform === "claude" ? "Claude Code" : "Codex";
  test(`issue-writers drafts and hook-publishes through a resumed real ${cliName} session`, async () => {
    const result = await runIssueWritersJourney(platform);
    assert.deepEqual(result.checkpoints, ["draft-write", "draft-complete"]);
    assert.equal(result.inferenceRequestsBeforePublish, result.inferenceRequestsAfterPublish);
    assert.equal(result.draftExistsAfterPublish, false);
    assert.equal(result.published.title, "Document deterministic issue journeys");
    assert.deepEqual(result.published.labels, ["[AI]-routine-difficulty", "[AI]-afk"]);
    assert.match(result.published.body, /real CLI and fake endpoint/iu);
    assert.equal(result.published.body.includes("issues-gateway:"), false);
    assert.equal(result.unexpectedRequests, 0);
  });
}
