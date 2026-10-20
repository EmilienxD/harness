import assert from "node:assert/strict";
import test from "node:test";

import { runIssueReadersBlockedJourney, runIssueReadersJourney } from "../tools/issue-readers/run.js";

for (const [skill, failure] of [
  ["address", "dirty"], ["address", "exception"], ["address", "timeout"],
  ["review", "exception"], ["review", "timeout"],
] as const) {
  test(`Codex ${skill}-this ${failure} rejection stops before inference`, { timeout: 60_000 }, async () => {
    const result = await runIssueReadersBlockedJourney(failure, skill);
    assert.equal(result.code, 0);
    assert.equal(result.inferenceRequests, 0);
    assert.equal(result.unexpectedRequests, 0);
    assert.equal(result.fileContent, failure === "dirty" ? "uncommitted\n" : "before\n");
    const events = result.output.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as { type: string; item?: { type: string } });
    assert.ok(events.some((event) => event.type === "turn.completed"));
    assert.ok(!events.some((event) => event.item && event.item.type !== "error"));
  });
}

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
