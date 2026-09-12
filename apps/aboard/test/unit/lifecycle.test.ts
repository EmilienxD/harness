import assert from "node:assert/strict";
import test from "node:test";

import { WorkerLifecycleReconciler, reportsResult } from "../../src/bridge/lifecycle.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId, WorkerResult } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import { WriteLease } from "../../src/domain/lease.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;
const startedAt = at("2026-07-30T10:00:00.000Z");

function worker(delivery: AgentSession["resultDelivery"] = { mode: "tool-result" }): AgentSession {
  return {
    platform: "claude",
    identity: { agentId: agent("worker-10"), type: "implementer" },
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    sessionBinding: "bound",
    terminal: { terminalId: terminal("terminal-10"), name: "worker" },
    lifecycle: { status: "starting", startedAt },
    resultDelivery: delivery,
    telemetry: { totalTokens: 12, totalDurationMs: 34, totalToolUseCount: 2, compactionCount: 1 },
  };
}

function setup(clean = true, delivery: AgentSession["resultDelivery"] = { mode: "tool-result" }, autoRunRestricted = false) {
  const fleet = new FleetRegistry();

  fleet.register({ ...worker(delivery), ...(autoRunRestricted ? { autoRunRestricted: true as const } : {}) }, startedAt);
  fleet.transition(agent("worker-10"), { status: "running", startedAt }, startedAt);
  const lease = new WriteLease();
  lease.acquire("write-capable", { agentId: agent("worker-10"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee") }, startedAt, "test launch");
  const delivered: WorkerResult[] = [];
  const finished: { session: AgentSession; result: WorkerResult }[] = [];
  const reconciler = new WorkerLifecycleReconciler({
    fleet, lease, workingTree: { isClean: async () => clean },
    completions: {
      complete(agentId, result) {
        const current = fleet.get(agentId)!;
        if (current.lifecycle.status === "completed" || current.lifecycle.status === "failed") return false;
        const finishedAt = at("2026-07-30T10:05:00.000Z");
        fleet.transition(agentId, result.outcome === "succeeded"
          ? { status: "completed", startedAt, finishedAt, exitCode: result.exitCode, lastAssistantMessage: result.lastAssistantMessage }
          : { status: "failed", startedAt, finishedAt, failure: result.failure }, finishedAt);
        fleet.recordResult(agentId, result, finishedAt);
        delivered.push(result);
        return true;
      },
    },
    onFinished: (session, result) => finished.push({ session, result }),
  });
  return { fleet, lease, reconciler, delivered, finished };
}

const identity = { agentId: agent("worker-10"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee") };

test("a provisional session identity binds once and rejects stale or duplicate discoveries", () => {
  const fleet = new FleetRegistry();
  const provisional = worker();
  fleet.register({ ...provisional, sessionBinding: "provisional" }, startedAt);
  const actual = session("af817a6c-cd41-41e2-a4db-44d3f43cd560");
  assert.equal(fleet.bindSession(identity.agentId, identity.sessionId, actual, startedAt), true);
  assert.equal(fleet.get(identity.agentId)?.sessionId, actual);
  assert.equal(fleet.get(identity.agentId)?.sessionBinding, "bound");
  assert.equal(fleet.bindSession(identity.agentId, identity.sessionId, session("c15badb6-d6c8-45a6-a59f-e931cd364332"), startedAt), false);
});

test("clean Stop succeeds, uses the supplied last message, and releases the lease", async () => {
  const { reconciler, lease, delivered, finished } = setup();
  assert.equal(await reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "committed" }), true);
  assert.equal(delivered[0]?.outcome, "succeeded");
  assert.equal(delivered[0]?.outcome === "succeeded" && delivered[0].lastAssistantMessage, "committed");
  assert.equal(lease.current(), undefined);
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.session.identity.agentId, identity.agentId);
  assert.equal(finished[0]?.result.outcome, "succeeded");
});

test("dirty write-capable Stop becomes no-commit", async () => {
  const { reconciler, delivered, lease } = setup(false);
  await reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "done" });
  assert.equal(delivered[0]?.outcome === "failed" && delivered[0].failure.type, "no-commit");
  assert.equal(lease.current(), undefined);
});

test("Auto Run receives process success independently of dirty repository state", async () => {
  const dirty = setup(false, { mode: "tool-result" }, true);
  await dirty.reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "left the change in the tree" });
  assert.equal(dirty.delivered[0]?.outcome, "succeeded");
  assert.equal(dirty.lease.current(), undefined);

  const committed = setup();
  await committed.reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "done" });
  assert.equal(committed.delivered[0]?.outcome, "succeeded");
});

test("non-zero, kill, timeout, and StopFailure paths are typed and release", async () => {
  for (const [expected, act] of [
    ["crashed", (r: WorkerLifecycleReconciler) => r.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "partial", exitCode: 1 })],
    ["killed", (r: WorkerLifecycleReconciler) => r.terminalClosed({ type: "terminal-closed", terminalId: terminal("terminal-10"), ...identity, exitCode: null, reason: "killed", occurredAt: startedAt })],
    ["timeout", (r: WorkerLifecycleReconciler) => r.timeout(identity.agentId, identity.sessionId, "partial")],
    ["context-exhausted", (r: WorkerLifecycleReconciler) => r.failure({ type: "failure", ...identity, failureType: "context-exhausted", message: "token limit", exitCode: null })],
  ] as const) {
    const { reconciler, delivered, lease } = setup();
    await act(reconciler);
    assert.equal(delivered[0]?.outcome === "failed" && delivered[0].failure.type, expected);
    assert.equal(lease.current(), undefined);
  }
});

test("duplicate events and Stop/close races settle exactly once", async () => {
  let releaseClean!: (value: boolean) => void;
  const { fleet, lease, delivered } = setup();
  const reconciler = new WorkerLifecycleReconciler({
    fleet, lease, workingTree: { isClean: () => new Promise((resolve) => { releaseClean = resolve; }) },
    completions: {
      complete(agentId, result) {
        const finishedAt = at("2026-07-30T10:05:00.000Z");
        fleet.transition(agentId, result.outcome === "succeeded"
          ? { status: "completed", startedAt, finishedAt, exitCode: 0, lastAssistantMessage: result.lastAssistantMessage }
          : { status: "failed", startedAt, finishedAt, failure: result.failure }, finishedAt);
        fleet.recordResult(agentId, result, finishedAt); delivered.push(result); return true;
      },
    },
  });
  const stop = reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "done" });
  const close = reconciler.terminalClosed({ type: "terminal-closed", terminalId: terminal("terminal-10"), ...identity, exitCode: 0, reason: "exited", occurredAt: startedAt });
  releaseClean(true);
  assert.deepEqual(await Promise.all([stop, close]), [true, false]);
  assert.equal(await reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "again" }), false);
  assert.equal(delivered.length, 1);
  assert.equal(lease.events().filter((event) => event.type === "released").length, 1);
});

test("a stale stop cannot occupy the current session's settlement slot", async () => {
  const { reconciler, delivered } = setup();
  const stale = reconciler.stop({
    agentId: identity.agentId,
    sessionId: session("stale-session"),
    cwd: "C:\\repo",
    lastAssistantMessage: "old result",
  });
  const current = reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "current result" });

  assert.deepEqual(await Promise.all([stale, current]), [false, true]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.outcome === "succeeded" && delivered[0].lastAssistantMessage, "current result");
});

test("only Auto Run workers with result delivery are reconciled on terminal close", () => {
  const automated = worker();
  assert.equal(reportsResult(automated), true);
  assert.equal(reportsResult({ ...automated, resultDelivery: { mode: "none" } }), false);
  assert.equal(reportsResult({ ...automated, identity: { agentId: agent("a"), type: "reviewer" } }), true);
  assert.equal(reportsResult({ ...automated, identity: { agentId: agent("a"), type: "interactive" }, attended: true }), false);
  assert.equal(reportsResult({ ...automated, identity: { agentId: agent("a"), type: "Explore" }, resultDelivery: { mode: "none" } }), false);
});
