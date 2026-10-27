import assert from "node:assert/strict";
import test from "node:test";

import { runIssueWritersJourney } from "../tools/issue-writers/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  const cliName = platform === "claude" ? "Claude Code" : "Codex";
  test(`issue-writers agent publishes with automatic identity through real ${cliName}`, async () => {
    const result = await runIssueWritersJourney(platform, "agent");
    assert.deepEqual(result.checkpoints, ["draft-write", "draft-complete", "agent-publish", "agent-published"]);
    assert.equal(result.inferenceRequestsBeforePublish, 2);
    assert.equal(result.inferenceRequestsAfterPublish, 4);
    assert.equal(result.draftExistsAfterPublish, false);
    assert.equal(result.draftDirEntriesAfterPublish.length, 2);
    assert.equal(result.published.title, "Document deterministic issue journeys");
    assert.equal(result.unexpectedRequests, 0);
  });
  test(`issue-writers drafts and hook-publishes through a resumed real ${cliName} session`, async () => {
    const result = await runIssueWritersJourney(platform);
    assert.deepEqual(result.checkpoints, ["draft-write", "draft-complete"]);
    assert.equal(result.inferenceRequestsBeforePublish, result.inferenceRequestsAfterPublish);
    assert.equal(result.draftExistsAfterPublish, false);
    // Publishing leaves nothing behind in the working tree but the drafts
    // directory's own .gitignore: no state, lock, bookkeeping file, and no
    // per-session subfolder.
    assert.deepEqual(result.draftDirEntriesAfterPublish, [".gitignore"]);
    assert.equal(result.published.title, "Document deterministic issue journeys");
    assert.deepEqual(result.published.labels, ["[AI]-routine-difficulty", "[AI]-afk"]);
    assert.match(result.published.body, /real CLI and fake endpoint/iu);
    // Nothing hidden is injected into a body a human will read.
    assert.equal(result.published.body.includes("<!--"), false);
    assert.equal(result.unexpectedRequests, 0);
  });
}
