import assert from "node:assert/strict";
import { runRemoveAnthropicCoauthorJourney } from "./run.js";

runRemoveAnthropicCoauthorJourney().then((result) => {
  assert.deepEqual(result.checkpoints, ["commit-opus", "commit-sonnet", "complete"]);
  assert.deepEqual(result.messages, [
    "Sonnet fixture\n\nCo-Authored-By: Alice <alice@example.invalid>",
    "Opus fixture\n\nCo-Authored-By: Alice <alice@example.invalid>",
  ]);
  assert.equal(result.committedBytes, "sonnet committed\n");
  assert.equal(result.stagedChangesPreserved, true);
  assert.equal(result.commitMetadataPreserved, true);
  assert.equal(result.originalTrailersPresent, true);
  assert.equal(result.unexpectedRequests, 0);
  assert.equal(result.inferenceRequests, 3);
  process.stdout.write("remove-anthropic-coauthor real Claude CLI E2E passed\n");
}).catch(() => {
  process.stderr.write("remove-anthropic-coauthor E2E failed; structural checks or commit effects did not match\n");
  process.exitCode = 1;
});
