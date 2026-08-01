import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionLifecycleService,
  SessionProcessMonitor,
  SessionStartTimeoutError,
  SessionStartupProofs,
  createSessionLifecycleRoutes,
  type SessionStartObservation,
} from "../src/bridge/session-lifecycle.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;
const startedAt = at("2026-08-01T09:00:00.000Z");

const LOCK = "C:\\repo\\.aboard\\runtime\\locks\\a1.lock";

function registerAgent(fleet: FleetRegistry, agentId: AgentId, sessionId: SessionId, type: AgentSession["identity"]["type"] = "implementer"): void {
  fleet.register({
    identity: { agentId, type },
    sessionId,
    terminal: { terminalId: terminal(`t-${agentId}`), name: "test" },
    lifecycle: { status: "starting", startedAt },
    resultDelivery: { mode: "none" },
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  }, startedAt);
}

function setup(probe: (lockFile: string) => boolean) {
  const fleet = new FleetRegistry();
  const lease = new WriteLease();
  const ended: string[] = [];
  const settled: AgentId[] = [];
  const monitor = new SessionProcessMonitor({
    probe,
    onProcessEnded: (observation) => ended.push(observation.agentId),
  });
  const service = new SessionLifecycleService({
    fleet,
    monitor,
    settlement: { settleCleared: (agentId) => settled.push(agentId) },
    lockPathFor: () => LOCK,
  });
  return { fleet, lease, monitor, service, ended, settled };
}

const start: SessionStartObservation = { agentId: agent("a1"), sessionId: session("s1"), source: "startup" };

test("session-start tracks the wrapper's lock marker and emits proof-of-life", () => {
  const proofs = new SessionStartupProofs();
  const { fleet, monitor, service } = setup(() => true);
  const done: string[] = [];
  const waiting = proofs.awaitStarted(agent("a1"), session("s1"), 5_000).then(() => { done.push("resolved"); });
  monitor.start(60_000);
  registerAgent(fleet, agent("a1"), session("s1"));
  const routes = createSessionLifecycleRoutes({ service, proofs });
  const response = routes({
    method: "POST",
    url: new URL("http://127.0.0.1/hooks/session-start"),
    headers: {},
    body: { agentId: "a1", sessionId: "s1", source: "startup" },
    signal: new AbortController().signal,
  });
  return Promise.all([waiting, response]).then(([, body]) => {
    assert.equal(monitor.isTracked(agent("a1")), true);
    assert.equal(monitor.registration(agent("a1"))?.lockFile, LOCK);
    assert.deepEqual(done, ["resolved"]);
    assert.equal(body.status, 200);
    monitor.stop();
  });
});

test("startup proof times out with a failure when no SessionStart arrives", async () => {
  const proofs = new SessionStartupProofs();
  const error = await proofs.awaitStarted(agent("a1"), session("s1"), 25).catch((caught: unknown) => caught);
  assert.ok(error instanceof SessionStartTimeoutError);
  assert.match(error.message, /did not start/);
});

test("terminal close cancels a pending proof instead of timing out", async () => {
  const proofs = new SessionStartupProofs();
  const promise = proofs.awaitStarted(agent("a1"), session("s1"), 5_000);
  proofs.cancel(agent("a1"));
  const error = await promise.catch((caught: unknown) => caught);
  assert.equal(error instanceof SessionStartTimeoutError, false);
});

test("a stale session-start from another session id does not discharge the proof", async () => {
  const proofs = new SessionStartupProofs();
  const promise = proofs.awaitStarted(agent("a1"), session("s1"), 5_000);
  assert.equal(proofs.discharge({ agentId: agent("a1"), sessionId: session("other") }), false);
  proofs.cancel(agent("a1"));
  await promise.catch(() => undefined);
});

test("poll reports removed markers through onProcessEnded and stops tracking them", () => {
  const { fleet, monitor, service, ended } = setup(() => false);
  registerAgent(fleet, agent("a1"), session("s1"));
  service.sessionStarted(start);
  monitor.poll();
  assert.deepEqual(ended, [agent("a1")]);
  assert.equal(monitor.isTracked(agent("a1")), false);
});

test("poll keeps present markers tracked without emitting", () => {
  const { fleet, monitor, service, ended } = setup(() => true);
  registerAgent(fleet, agent("a1"), session("s1"));
  service.sessionStarted(start);
  monitor.poll();
  assert.deepEqual(ended, []);
  assert.equal(monitor.observe(agent("a1")), "live");
});

test("observe is missing for untracked agents so a silent hook cannot mask a stale lease", () => {
  const { monitor } = setup(() => true);
  assert.equal(monitor.observe(agent("never-started")), "missing");
});

test("session-end with reason clear settles gracefully and untracks", () => {
  const { fleet, monitor, service, settled, ended } = setup(() => true);
  registerAgent(fleet, agent("a1"), session("s1"));
  service.sessionStarted(start);
  const accepted = service.sessionEnded({ agentId: agent("a1"), sessionId: session("s1"), reason: "clear" });
  assert.equal(accepted, true);
  assert.deepEqual(settled, [agent("a1")]);
  monitor.poll();
  assert.deepEqual(ended, []);
});

test("session-end process-exit reasons are left to the marker poller", () => {
  const { fleet, monitor, service, settled } = setup(() => true);
  registerAgent(fleet, agent("a1"), session("s1"));
  service.sessionStarted(start);
  assert.equal(service.sessionEnded({ agentId: agent("a1"), sessionId: session("s1"), reason: "prompt_input_exit" }), false);
  assert.equal(monitor.isTracked(agent("a1")), true);
  assert.deepEqual(settled, []);
});

test("session events for unknown or stale sessions are ignored", () => {
  const { service } = setup(() => true);
  assert.equal(service.sessionStarted(start), false);
  assert.equal(service.sessionEnded({ agentId: agent("ghost"), sessionId: session("ghost"), reason: "clear" }), false);
});

test("routes validate reason and identity", async () => {
  const { fleet, service } = setup(() => true);
  registerAgent(fleet, agent("a1"), session("s1"));
  const routes = createSessionLifecycleRoutes({ service });
  const signal = new AbortController().signal;
  const post = (pathname: string, body: unknown) => routes({ method: "POST", url: new URL(`http://127.0.0.1${pathname}`), headers: {}, body, signal });

  const okStart = await post("/hooks/session-start", { agentId: "a1", sessionId: "s1", source: "startup" });
  assert.equal(okStart.status, 200);
  const badReason = await post("/hooks/session-end", { agentId: "a1", sessionId: "s1", reason: "mystery" });
  assert.equal(badReason.status, 400);
  const okClear = await post("/hooks/session-end", { agentId: "a1", sessionId: "s1", reason: "clear" });
  assert.equal(okClear.status, 200);
  assert.equal((okClear.body as { accepted: boolean }).accepted, true);
  const unknown = await post("/hooks/elsewhere", {});
  assert.equal(unknown.status, 404);
});

test("monitor uses injected timers and stops polling after stop()", () => {
  const callbacks: Array<() => void> = [];
  const ended: string[] = [];
  const monitor = new SessionProcessMonitor({
    probe: () => false,
    setInterval: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearInterval: () => undefined,
    onProcessEnded: (observation) => ended.push(observation.agentId),
  });
  monitor.track({ agentId: agent("a1"), sessionId: session("s1"), lockFile: LOCK });
  monitor.start(1_000);
  assert.equal(callbacks.length, 1);
  callbacks[0]!();
  assert.deepEqual(ended, [agent("a1")]);
  monitor.stop();
});
