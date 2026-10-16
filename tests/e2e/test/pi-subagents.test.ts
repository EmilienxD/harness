import assert from "node:assert/strict";
import test from "node:test";

import { runPiSubagentsJourney } from "../tools/pi-subagents/run.js";
import { childAnswer, parentDone, scenario } from "../tools/pi-subagents/scenario.js";

test("pi-subagents rejects unknown histories at its fake API", () => {
  assert.throws(() => scenario.transition({ model: "pi-e2e", input: [{ role: "user", content: "Unrelated." }], tools: [], codeMode: false, sessionId: null, requestKind: null }), /routing marker/u);
});

test("a headless Pi parent waits for its Pi auto child and integrates the result", { timeout: 300_000 }, async () => {
  const result = await runPiSubagentsJourney("auto");
  assert.equal(result.parentStatus, "success");
  assert.equal(result.parentFinal, parentDone("auto"));
  assert.deepEqual(result.request, { state: "succeeded", mode: "auto", provider: "pi", reply: childAnswer("auto"), acknowledged: true, boundToNativeSession: true });
  assert.equal(result.deliveredResults, 1);
  assert.equal(result.deliveryMatchesRequest, true);
  assert.equal(result.childSessionSaved, true);
  assert.equal(result.requestFilesRemaining, 0);
  // Parent write, parent wait, child answer, parent integration.
  assert.equal(result.inferenceRequests, 4);
  assert.equal(result.unexpectedRequests, 0);
});

test("an interactive Pi child replies without inference and wakes its live parent", { timeout: 300_000 }, async () => {
  const result = await runPiSubagentsJourney("interactive");
  assert.equal(result.previousReplyInferenceRequests, 0);
  assert.equal(result.parentStatus, "success");
  assert.equal(result.parentFinal, parentDone("interactive"));
  assert.deepEqual(result.request, { state: "succeeded", mode: "interactive", provider: "pi", reply: childAnswer("interactive"), acknowledged: true, boundToNativeSession: true });
  assert.equal(result.deliveredResults, 1);
  assert.equal(result.deliveryMatchesRequest, true);
  assert.equal(result.childSessionSaved, true);
  assert.equal(result.requestFilesRemaining, 0);
  assert.equal(result.inferenceRequests, 4);
  assert.equal(result.unexpectedRequests, 0);
});
