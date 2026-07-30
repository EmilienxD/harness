import assert from "node:assert/strict";
import test from "node:test";

import type { DelegationCoordinator, DelegationLaunchInput } from "../src/bridge/delegation.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import type { GitHubClient } from "../src/github/client.js";
import { ReviewCoordinator } from "../src/github/review.js";

const at = "2026-07-30T10:00:00.000Z" as IsoTimestamp;
const emptyTelemetry = { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 };

function session(type: AgentSession["identity"]["type"], id: string, issueNumber?: number): AgentSession {
  return {
    identity: { agentId: id as AgentId, type },
    sessionId: (type === "manager" ? "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee" : "af817a6c-cd41-41e2-a4db-44d3f43cd560") as SessionId,
    terminal: { terminalId: `${id}-terminal` as TerminalId, name: id },
    lifecycle: { status: "starting", startedAt: at },
    resultDelivery: type === "manager" ? { mode: "none" } : { mode: "mailbox", managerAgentId: "manager" as AgentId },
    telemetry: emptyTelemetry,
    ...(issueNumber === undefined ? {} : { issueNumber }),
  };
}

function setup(options: { labels?: readonly string[]; original?: boolean; unresolved?: boolean } = {}) {
  const calls: Array<{ kind: "spawn" | "send"; value: unknown }> = [];
  const delegation = {
    spawn: async (input: DelegationLaunchInput) => { calls.push({ kind: "spawn", value: input }); return { status: "running" }; },
    send: async (agentId: AgentId, message: string) => { calls.push({ kind: "send", value: { agentId, message } }); return { status: "running" }; },
  } as unknown as DelegationCoordinator;
  const github = {
    getPullRequest: async () => ({ number: 42, title: "PR", body: "", headBranch: "feat", baseBranch: "main", state: "open", issueNumber: 17 }),
    getIssue: async () => ({ number: 17, title: "Issue", body: "", labels: options.labels ?? ["hitl"], state: "open" }),
    listReviewThreads: async () => options.unresolved === false ? [] : [{ id: "T1", path: "a.ts", line: 1, isResolved: false, comments: [] }],
  } as unknown as GitHubClient;
  const fleet = new FleetRegistry();
  fleet.register(session("manager", "manager"), at);
  fleet.transition("manager" as AgentId, { status: "running", startedAt: at }, at);
  if (options.original) {
    fleet.register(session("implementer", "implementer-17", 17), at);
    fleet.transition("implementer-17" as AgentId, { status: "running", startedAt: at }, at);
    fleet.transition("implementer-17" as AgentId, { status: "completed", startedAt: at, finishedAt: at, exitCode: 0, lastAssistantMessage: "done" }, at);
  }
  return { coordinator: new ReviewCoordinator(github, delegation, fleet), calls };
}

test("default never performs no automatic review while explicit review launches read-only reviewer", async () => {
  const { coordinator, calls } = setup();
  assert.equal(await coordinator.maybeAutoReview({ pr: 42 }, "never"), undefined);
  assert.equal(calls.length, 0);
  await coordinator.review({ pr: 42, focus: "boundaries" });
  assert.deepEqual(calls[0], { kind: "spawn", value: {
    type: "reviewer",
    prompt: "Review this pull request against its resolved contract and persist every finding as a line-specific GitHub review comment.",
    description: "review pull request 42",
    pullRequest: 42,
    focus: "boundaries",
  } });
});

test("hitl auto-review follows only the configured disposition", async () => {
  const skipped = setup({ labels: ["afk"] });
  assert.equal(await skipped.coordinator.maybeAutoReview({ pr: 42 }, "hitl"), undefined);
  assert.equal(skipped.calls.length, 0);
  const launched = setup({ labels: ["hitl"] });
  await launched.coordinator.maybeAutoReview({ pr: 42 }, "hitl");
  assert.equal(launched.calls.length, 1);
});

test("routes surviving feedback to the original implementer, then falls back to a fixer", async () => {
  const original = setup({ original: true });
  assert.equal((await original.coordinator.routeFixes(42)).route, "original-implementer");
  assert.equal(original.calls[0]?.kind, "send");

  const fallback = setup();
  assert.equal((await fallback.coordinator.routeFixes(42)).route, "fixer");
  assert.deepEqual((fallback.calls[0]?.value as DelegationLaunchInput).type, "fixer");

  const none = setup({ unresolved: false });
  assert.deepEqual(await none.coordinator.routeFixes(42), { route: "none", reason: "no-unresolved-threads" });
});
