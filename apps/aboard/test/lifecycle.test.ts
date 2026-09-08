import assert from "node:assert/strict";
import test from "node:test";

import { WorkerLifecycleReconciler, classifyStopFailure, createWorkerLifecycleRoutes, reportsResult } from "../src/bridge/lifecycle.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId, WorkerResult } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;
const startedAt = at("2026-07-30T10:00:00.000Z");

function worker(delivery: AgentSession["resultDelivery"] = { mode: "tool-result" }, expectsUncommittedTree = false): AgentSession {
  return {
    identity: { agentId: agent("worker-10"), type: "implementer" },
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    terminal: { terminalId: terminal("terminal-10"), name: "worker" },
    lifecycle: { status: "starting", startedAt },
    resultDelivery: delivery,
    telemetry: { totalTokens: 12, totalDurationMs: 34, totalToolUseCount: 2, compactionCount: 1 },
    ...(expectsUncommittedTree ? { expectsUncommittedTree: true } : {}),
  };
}

function setup(clean = true, delivery: AgentSession["resultDelivery"] = { mode: "tool-result" }, expectsUncommittedTree = false) {
  const fleet = new FleetRegistry();

  fleet.register(worker(delivery, expectsUncommittedTree), startedAt);
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

test("no-commit is not raised when the launch expected an uncommitted tree", async () => {
  const expected = setup(false, { mode: "tool-result" }, true);
  await expected.reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "left the change in the tree" });
  assert.equal(expected.delivered[0]?.outcome, "succeeded");
  assert.equal(expected.lease.current(), undefined);

  // A manually delegated write-capable agent still owes a commit.
  const manual = setup(false);
  await manual.reconciler.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "done" });
  assert.equal(manual.delivered[0]?.outcome === "failed" && manual.delivered[0].failure.type, "no-commit");
});

test("non-zero, kill, timeout, and StopFailure paths are typed and release", async () => {
  for (const [expected, act] of [
    ["crashed", (r: WorkerLifecycleReconciler) => r.stop({ ...identity, cwd: "C:\\repo", lastAssistantMessage: "partial", exitCode: 1 })],
    ["killed", (r: WorkerLifecycleReconciler) => r.terminalClosed({ type: "terminal-closed", terminalId: terminal("terminal-10"), ...identity, exitCode: null, reason: "killed", occurredAt: startedAt })],
    ["timeout", (r: WorkerLifecycleReconciler) => r.timeout(identity.agentId, identity.sessionId, "partial")],
    ["context-exhausted", (r: WorkerLifecycleReconciler) => r.stopFailure({ ...identity, error: "max_output_tokens", lastAssistantMessage: "token limit" })],
  ] as const) {
    const { reconciler, delivered, lease } = setup();
    await act(reconciler);
    assert.equal(delivered[0]?.outcome === "failed" && delivered[0].failure.type, expected);
    assert.equal(lease.current(), undefined);
  }
  assert.equal(classifyStopFailure("authentication_failed", "API error"), "permission-denied");
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
});

test("hook routes validate identities and accept Claude snake-case result fields", async () => {
  const { reconciler } = setup();
  const handler = createWorkerLifecycleRoutes(reconciler);
  const request = (path: string, body: unknown): AuthenticatedBridgeRequest => ({
    method: "POST", url: new URL(path, "http://127.0.0.1"), headers: {}, body,
    signal: new AbortController().signal,
  });
  const result = await handler(request("/hooks/stop", {
    agentId: "worker-10", session_id: identity.sessionId, cwd: "C:\\repo", last_assistant_message: "done",
  }));
  assert.equal(result.status, 200);
  assert.equal((await handler(request("/hooks/stop", { agentId: "worker-10" }))).status, 400);
});

test("only Auto Run workers with result delivery are reconciled on terminal close", () => {
  const automated = worker();
  assert.equal(reportsResult(automated), true);
  assert.equal(reportsResult({ ...automated, resultDelivery: { mode: "none" } }), false);
  assert.equal(reportsResult({ ...automated, identity: { agentId: agent("a"), type: "reviewer" } }), true);
  assert.equal(reportsResult({ ...automated, identity: { agentId: agent("a"), type: "interactive" }, attended: true }), false);
  assert.equal(reportsResult({ ...automated, identity: { agentId: agent("a"), type: "Explore" }, resultDelivery: { mode: "none" } }), false);
});
