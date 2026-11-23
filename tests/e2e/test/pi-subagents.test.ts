import assert from "node:assert/strict";
import test from "node:test";

import { runPiSubagentsJourney } from "../tools/pi-subagents/run.js";
import { childAnswer, parentDone, scenario } from "../tools/pi-subagents/scenario.js";

test("pi-subagents rejects unknown histories at its fake API", () => {
  assert.throws(() => scenario.transition({ model: "pi-e2e", input: [{ role: "user", content: "Unrelated." }], tools: [], codeMode: false, sessionId: null, requestKind: null }), /routing marker/u);
});

test("combined live acceptance rejects remote services before creating a fixture", async () => {
  await assert.rejects(runPiSubagentsJourney("auto", { fullStack: true, localBoard: { origin: "https://grill.example.test", code: "unused-test-code" } }), /loopback/u);
  await assert.rejects(runPiSubagentsJourney("auto", { localBoard: { origin: "http://127.0.0.1:18080", code: "unused-test-code" } }), /loopback/u);
});

for (const [route, pinnedRuntimes] of [["auto", false], ["auto", true], ["interactive", false], ["interactive", true]] as const) {
  test(`a cloud interview delegates the requested model and effort in ${route} mode with the installed extension stack (${pinnedRuntimes ? "shipped pin" : "checkout runtime"})`, { timeout: 300_000 }, async () => {
    const result = await runPiSubagentsJourney(route, { pinnedRuntimes, fullStack: true, explicitModel: true });
    assert.equal(result.parentStatus, "success");
    assert.equal(result.parentFinal, parentDone(route));
    assert.equal(result.request.state, "succeeded");
    assert.equal(result.request.provider, "pi");
    assert.equal(result.request.mode, route);
    assert.equal(result.request.boundToNativeSession, true);
    assert.equal(result.request.acknowledged, true);
    assert.equal(result.deliveryMatchesRequest, true);
    assert.equal(result.deliveredResults, 1);
    assert.equal(result.publishedRounds, 1);
    assert.equal(result.requestedModel, "gpt-6.1-sol");
    assert.equal(result.requestedEffort, "medium");
    assert.equal(result.childModel, "gpt-6.1-sol");
    assert.equal(result.childThinkingLevel, "medium");
    assert.equal(result.childSessionSaved, true);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.inferenceRequests, 6);
    assert.equal(result.unexpectedRequests, 0);
    if (route === "interactive") assert.equal(result.previousReplyInferenceRequests, 0);
  });
}

for (const pinnedRuntimes of [false, true]) {
  test(`a headless Pi parent integrates its auto child using ${pinnedRuntimes ? "the shipped runtime pin" : "the checkout runtime"}`, { timeout: 300_000 }, async () => {
    const result = await runPiSubagentsJourney("auto", { pinnedRuntimes });
    assert.equal(result.parentStatus, "success");
    assert.equal(result.parentFinal, parentDone("auto"));
    assert.deepEqual(result.request, { state: "succeeded", mode: "auto", provider: "pi", reply: childAnswer("auto"), acknowledged: true, boundToNativeSession: true });
    assert.equal(result.deliveredResults, 1);
    assert.equal(result.deliveryMatchesRequest, true);
    assert.equal(result.childSessionSaved, true);
    assert.equal(result.requestFilesRemaining, 0);
    // Parent activation, parent write, parent wait, child answer, parent integration.
    assert.equal(result.inferenceRequests, 5);
    assert.equal(result.unexpectedRequests, 0);
  });
}

test("a Pi child installs its fresh worktree packages, replies without inference, and wakes its live parent", { timeout: 300_000 }, async () => {
  const result = await runPiSubagentsJourney("interactive", { pinnedRuntimes: false, alternateRoot: true });
  assert.equal(result.previousReplyInferenceRequests, 0);
  assert.equal(result.parentStatus, "success");
  assert.equal(result.request.state, "succeeded");
  assert.equal(result.request.acknowledged, true);
  assert.equal(result.inferenceRequests, 6);
  assert.equal(result.deliveredResults, 1);
  assert.equal(result.unexpectedRequests, 0);
});

test("an interactive Pi child replies without inference and wakes its live parent", { timeout: 300_000 }, async () => {
  const result = await runPiSubagentsJourney("interactive", { pinnedRuntimes: true });
  assert.equal(result.previousReplyInferenceRequests, 0);
  assert.equal(result.parentStatus, "success");
  assert.equal(result.parentFinal, parentDone("interactive"));
  assert.deepEqual(result.request, { state: "succeeded", mode: "interactive", provider: "pi", reply: childAnswer("interactive"), acknowledged: true, boundToNativeSession: true });
  assert.equal(result.deliveredResults, 1);
  assert.equal(result.deliveryMatchesRequest, true);
  assert.equal(result.childSessionSaved, true);
  assert.equal(result.requestFilesRemaining, 0);
  assert.equal(result.inferenceRequests, 5);
  assert.equal(result.unexpectedRequests, 0);
});

test("a busy Pi parent receives its child's reply before its next inference request", { timeout: 300_000 }, async () => {
  const result = await runPiSubagentsJourney("interactive", { pinnedRuntimes: false, busyParent: true });
  assert.equal(result.busyDeliveryClaimed, true);
  assert.equal(result.previousReplyInferenceRequests, 0);
  assert.equal(result.parentStatus, "success");
  assert.equal(result.parentFinal, parentDone("interactive"));
  assert.deepEqual(result.request, { state: "succeeded", mode: "interactive", provider: "pi", reply: childAnswer("interactive"), acknowledged: true, boundToNativeSession: true });
  assert.equal(result.deliveredResults, 1);
  assert.equal(result.deliveryMatchesRequest, true);
  assert.equal(result.childSessionSaved, true);
  assert.equal(result.requestFilesRemaining, 0);
  assert.equal(result.inferenceRequests, 6);
  assert.equal(result.unexpectedRequests, 0);
});

for (const route of ["auto", "interactive"] as const) {
  test(`Pi discovers a BOM request from a ${route === "auto" ? "failed" : "successful"} shell tool in ${route} mode`, { timeout: 300_000 }, async () => {
    const result = await runPiSubagentsJourney(route, { pinnedRuntimes: false, shellWrite: true, failedWrite: route === "auto" });
    assert.equal(result.parentFinal, parentDone(route));
    assert.equal(result.request.state, "succeeded");
    assert.equal(result.request.acknowledged, true);
    assert.equal(result.deliveredResults, 1);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.inferenceRequests, 5);
    assert.equal(result.unexpectedRequests, 0);
  });
}
