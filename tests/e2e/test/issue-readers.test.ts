import assert from "node:assert/strict";
import test from "node:test";

import { runIssueReadersJourney } from "../tools/issue-readers/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  const cliName = platform === "claude" ? "Claude Code" : "Codex";
  test(`issue-readers carries address and review context through a resumed real ${cliName} session`, async () => {
    const result = await runIssueReadersJourney(platform);
    assert.deepEqual(result.checkpoints, ["address-read", "address-write", "address-stage", "address-commit", "address-complete", "review-complete"]);
    assert.equal(result.fileContent, "addressed issue 42\n");
    assert.equal(result.commitSubject, "Address fixture issue 42");
    assert.match(result.reviewText, /reviewed the issue 42 commit/iu);
    assert.equal(result.unexpectedRequests, 0);
  });
}
