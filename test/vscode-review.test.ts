import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewCoordinator, ReviewOutcome, ReviewRequest } from "../src/github/review.js";
import { registerReviewCommand, type ReviewCommandHost } from "../src/vscode/review.js";

function setup(outcome: ReviewOutcome) {
  let callback: ((...args: readonly unknown[]) => unknown) | undefined;
  const requests: ReviewRequest[] = [];
  const messages: string[] = [];
  const host: ReviewCommandHost = {
    registerCommand: (_command, registered) => { callback = registered; return { dispose() {} }; },
    info: (message) => messages.push(message),
    error: () => assert.fail("reopening should not fail"),
  };
  const reviews = { review: async (request: ReviewRequest = {}) => { requests.push(request); return outcome; } } as ReviewCoordinator;
  registerReviewCommand(host, reviews);
  return { invoke: async (...args: readonly unknown[]) => { await callback?.(...args); }, requests, messages };
}

test("the panel action asks for nothing and targets the pull request in flight", async () => {
  const { invoke, requests, messages } = setup({ action: "focused", prNumber: 42, agentId: "a", type: "implementer" });
  await invoke();
  assert.deepEqual(requests, [{}]);
  assert.equal(messages[0], "Focused the implementer terminal for PR #42.");
});

test("a positional pull request number narrows the action, and junk is ignored", async () => {
  const { invoke, requests } = setup({ action: "resumed", prNumber: 17, agentId: "a", type: "pr-doctor-afk" });
  await invoke(17);
  await invoke("not a number");
  await invoke(0);
  assert.deepEqual(requests, [{ pr: 17 }, {}, {}]);
});

test("no open pull request reports that nothing was reopened", async () => {
  const { invoke, messages } = setup({ action: "none", reason: "no-open-pull-request" });
  await invoke();
  assert.match(messages[0]!, /No pull request is open/);
});
