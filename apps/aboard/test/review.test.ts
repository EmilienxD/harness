import assert from "node:assert/strict";
import test from "node:test";

import type { PullRequestOwner } from "../src/auto/engine.js";
import type { DelegationCoordinator, DelegationLaunchInput } from "../src/bridge/delegation.js";
import type { AgentId, SessionId, TerminalId } from "../src/domain/contracts.js";
import type { LaunchOrigin } from "../src/domain/lease.js";
import type { GitHubClient } from "../src/github/client.js";
import { ReviewCoordinator } from "../src/github/review.js";

function owner(overrides: Partial<PullRequestOwner> = {}): PullRequestOwner {
  return {
    prNumber: 42,
    agentId: "agent-1" as AgentId,
    sessionId: "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId,
    terminalId: "terminal-1" as TerminalId,
    type: "implementer",
    issueNumber: 17,
    ...overrides,
  };
}

function setup(options: { readonly latest?: number; readonly owner?: PullRequestOwner; readonly live?: boolean } = {}) {
  const launched: DelegationLaunchInput[] = [];
  const origins: LaunchOrigin[] = [];
  const resumed: PullRequestOwner[] = [];
  const focused: TerminalId[] = [];
  const delegation = {
    launchInteractive: async (input: DelegationLaunchInput, origin: LaunchOrigin) => {
      launched.push(input);
      origins.push(origin);
      return { agentId: "agent-2" as AgentId, sessionId: "0f9e8d7c-6b5a-4938-8271-6a5b4c3d2e1f" as SessionId, terminalId: "terminal-2" as TerminalId };
    },
  } as unknown as DelegationCoordinator;
  const github = {
    findLatestOpenPullRequest: async () => options.latest,
  } as unknown as GitHubClient;
  const coordinator = new ReviewCoordinator(
    github,
    delegation,
    { owner: () => options.owner },
    {
      focus: (terminalId) => { focused.push(terminalId); return options.live !== false; },
      resume: async (value) => { resumed.push(value); },
    },
  );
  return { coordinator, launched, origins, resumed, focused };
}

test("no open pull request launches nothing", async () => {
  const { coordinator, launched, resumed } = setup();
  assert.deepEqual(await coordinator.review(), { action: "none", reason: "no-open-pull-request" });
  assert.equal(launched.length, 0);
  assert.equal(resumed.length, 0);
});

test("an open pull request with a live terminal is focused, never relaunched", async () => {
  const { coordinator, launched, resumed, focused } = setup({ latest: 42, owner: owner() });
  const outcome = await coordinator.review();
  assert.deepEqual(outcome, { action: "focused", prNumber: 42, agentId: "agent-1", type: "implementer" });
  assert.deepEqual(focused, ["terminal-1"]);
  assert.equal(launched.length, 0);
  assert.equal(resumed.length, 0);
});

test("a closed terminal resumes the owning session and delivers no result", async () => {
  const { coordinator, launched, resumed } = setup({ latest: 42, owner: owner({ type: "pr-doctor-afk" }), live: false });
  const outcome = await coordinator.review();
  assert.deepEqual(outcome, { action: "resumed", prNumber: 42, agentId: "agent-1", type: "pr-doctor-afk" });
  assert.equal(resumed[0]?.sessionId, "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071");
  assert.equal(launched.length, 0);
});

test("an unknown owner falls back to a fresh pr-doctor-hitl and says so", async () => {
  const { coordinator, launched, origins } = setup({ latest: 7 });
  const outcome = await coordinator.review({ focus: "boundaries" });
  assert.equal(outcome.action, "launched");
  assert.match((outcome as { notice: string }).notice, /No aboard session is recorded for PR #7/);
  assert.deepEqual(launched[0], {
    type: "pr-doctor-hitl",
    pullRequest: 7,
    description: "review pull request 7",
    focus: "boundaries",
  });
  // No run owns this pull request, so nothing commits behind the terminal: the
  // doctor is a handoff with no first message and takes no lease.
  assert.deepEqual(origins, ["manager"]);
});

test("a focus that lands on an existing session is reported unused, never silently dropped", async () => {
  const live = setup({ latest: 42, owner: owner() });
  assert.deepEqual(await live.coordinator.review({ focus: "boundary validation" }), {
    action: "focused", prNumber: 42, agentId: "agent-1", type: "implementer", unusedFocus: "boundary validation",
  });
  assert.equal(live.launched.length, 0);

  const closed = setup({ latest: 42, owner: owner(), live: false });
  assert.deepEqual(await closed.coordinator.review({ focus: "boundary validation" }), {
    action: "resumed", prNumber: 42, agentId: "agent-1", type: "implementer", unusedFocus: "boundary validation",
  });
  assert.equal(closed.resumed.length, 1);
  assert.equal(closed.launched.length, 0);
});

test("an explicit pull request number bypasses the latest-open lookup", async () => {
  const { coordinator } = setup({ owner: owner({ prNumber: 99 }) });
  assert.equal((await coordinator.review({ pr: 99 })).action, "focused");
});
