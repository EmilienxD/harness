import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformLifecycleRoutes } from "../../src/bridge/platform-lifecycle.js";
import type { AuthenticatedBridgeRequest } from "../../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import { WriteLease } from "../../src/domain/lease.js";
import type { AgentPlatform } from "../../src/platform/agent-platform.js";
import { ClaudeAgentPlatform } from "../../src/claude/platform.js";

const at = "2026-09-08T10:00:00.000Z" as IsoTimestamp;
const original = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
const actual = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;
const agentId = "agent-1" as AgentId;

function registered(): AgentSession {
  return {
    platform: "claude", identity: { agentId, type: "interactive" }, sessionId: original, sessionBinding: "provisional",
    terminal: { terminalId: "terminal-1" as TerminalId, name: "agent" }, lifecycle: { status: "running", startedAt: at },
    resultDelivery: { mode: "none" }, attended: true,
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  };
}

test("platform lifecycle ingress binds a discovered id before shared services observe start", async () => {
  const fleet = new FleetRegistry();
  fleet.register({ ...registered(), lifecycle: { status: "starting", startedAt: at } }, at);
  fleet.transition(agentId, { status: "running", startedAt: at }, at);
  const starts: SessionId[] = [];
  const lease = new WriteLease();
  lease.acquire("write-capable", { agentId, sessionId: original }, at, "worker launch");
  let terminalSessionId = original;
  const terminalBinding = {
    canBindSession: (candidateAgentId: AgentId, expected: SessionId) => candidateAgentId === agentId && expected === terminalSessionId,
    bindSession: (_candidateAgentId: AgentId, _expected: SessionId, bound: SessionId) => { terminalSessionId = bound; },
  };
  const platform: AgentPlatform = {
    id: "claude",
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    capabilities: { sessionIdentity: "runtime-assigned", promptDelivery: ["none"], lifecycle: ["start"], models: [], reasoningEfforts: [] },
    createSession: () => ({ sessionId: original, binding: "provisional" }),
    bindSession: (current, observed) => current.binding === "provisional" ? observed : current.sessionId === observed ? observed : undefined,
    normalizeLifecycle: (_kind, payload) => ({ type: "start", agentId, sessionId: (payload as { actual: SessionId }).actual }),
    requireEnforceableRestrictions: () => undefined,
    planLaunch: () => { throw new Error("not used"); }, planSessionResume: () => { throw new Error("not used"); },
    preflight: async () => undefined, isResumable: async () => false,
  };
  const route = createPlatformLifecycleRoutes({
    fleet, platforms: new Map([["claude", platform]]), sessionBindings: [lease, terminalBinding],
    sessions: { sessionStarted: (observation) => {
      if (observation.sessionId !== fleet.get(agentId)?.sessionId) return false;
      starts.push(observation.sessionId);
      return true;
    }, sessionEnded: () => false },
    workers: { stop: async () => false, failure: async () => false },
    compactions: { compact: () => undefined },
    now: () => new Date(at),
  });
  const request = (body: unknown): AuthenticatedBridgeRequest => ({
    method: "POST", url: new URL("http://127.0.0.1/hooks/session-start"), headers: {}, body, signal: AbortSignal.abort(),
  });

  const accepted = await route(request({ agentId, actual }));
  assert.deepEqual(accepted, { status: 200, body: { ok: true, accepted: true } });
  assert.deepEqual(starts, [actual]);
  assert.equal(fleet.get(agentId)?.sessionId, actual);
  assert.equal(fleet.get(agentId)?.sessionBinding, "bound");
  assert.equal(lease.current()?.sessionId, actual);
  assert.equal(terminalSessionId, actual);

  const stale = await route(request({ agentId, actual: "c15badb6-d6c8-45a6-a59f-e931cd364332" }));
  assert.deepEqual(stale, { status: 200, body: { ok: true, accepted: false } });
  assert.deepEqual(starts, [actual]);
});

test("platform lifecycle ingress dispatches only normalized stop, end, compaction, and failure observations", async () => {
  const fleet = new FleetRegistry();
  const { attended: _attended, ...unattended } = registered();
  fleet.register({
    ...unattended,
    identity: { agentId, type: "address" },
    sessionId: actual,
    sessionBinding: "bound",
    lifecycle: { status: "starting", startedAt: at },
    resultDelivery: { mode: "tool-result" },
  }, at);
  fleet.transition(agentId, { status: "running", startedAt: at }, at);
  const observed: unknown[] = [];
  const platform = new ClaudeAgentPlatform({
    commandRunner: async () => ({ code: 0, stdout: "2.1.199 (Claude Code)", stderr: "" }),
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
  });
  const route = createPlatformLifecycleRoutes({
    fleet, platforms: new Map([["claude", platform]]),
    sessions: { sessionStarted: () => false, sessionEnded: (value) => { observed.push(value); return true; } },
    workers: {
      stop: async (value) => { observed.push(value); return true; },
      failure: async (value) => { observed.push(value); return true; },
    },
    compactions: { compact: (id, summary) => { observed.push({ type: "compaction", agentId: id, summary }); } },
  });
  const post = (path: string, body: unknown) => route({
    method: "POST", url: new URL(path, "http://127.0.0.1"), headers: {}, body, signal: AbortSignal.abort(),
  });

  await post("/hooks/stop", { agentId, session_id: actual, cwd: "C:\\repo", last_assistant_message: "done" });
  await post("/hooks/session-end", { agentId, session_id: actual, reason: "clear" });
  await post("/hooks/worker/post-compact", { agentId, session_id: actual, compact_summary: "summary" });
  await post("/hooks/stop-failure", { agentId, session_id: actual, error: "max_output_tokens", error_details: "limit" });
  const staleCompaction = await post("/hooks/worker/post-compact", {
    agentId,
    session_id: original,
    compact_summary: "stale summary",
  });

  assert.deepEqual(observed, [
    { type: "stop", agentId, sessionId: actual, cwd: "C:\\repo", lastAssistantMessage: "done" },
    { type: "end", agentId, sessionId: actual, reason: "clear" },
    { type: "compaction", agentId, summary: "summary" },
    { type: "failure", agentId, sessionId: actual, failureType: "context-exhausted", message: "limit", exitCode: null },
  ]);
  assert.deepEqual(staleCompaction, { status: 200, body: { ok: true, accepted: false } });
});

test("an attended session Stop records final output without settling the live conversation", async () => {
  const fleet = new FleetRegistry();
  fleet.register({ ...registered(), sessionId: actual, sessionBinding: "bound", lifecycle: { status: "starting", startedAt: at } }, at);
  fleet.transition(agentId, { status: "running", startedAt: at }, at);
  let workerStops = 0;
  const platform = new ClaudeAgentPlatform({
    commandRunner: async () => ({ code: 0, stdout: "2.1.199", stderr: "" }),
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
  });
  const route = createPlatformLifecycleRoutes({
    fleet,
    platforms: new Map([["claude", platform]]),
    sessions: { sessionStarted: () => false, sessionEnded: () => false },
    workers: { stop: async () => { workerStops += 1; return true; }, failure: async () => false },
    compactions: { compact: () => undefined },
    now: () => new Date(at),
  });
  const response = await route({
    method: "POST", url: new URL("http://127.0.0.1/hooks/stop"), headers: {}, signal: AbortSignal.abort(),
    body: { agentId, sessionId: actual, cwd: "C:/work", lastAssistantMessage: "A final attended answer." },
  });

  assert.deepEqual(response, { status: 200, body: { ok: true, accepted: true } });
  assert.equal(workerStops, 0);
  assert.equal(fleet.get(agentId)?.lastObservedAssistantMessage, "A final attended answer.");
  assert.equal(fleet.get(agentId)?.lifecycle.status, "running");
});
