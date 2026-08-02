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
  const confirmations: Array<{ readonly delayMs: number; readonly run: () => void }> = [];
  const monitor = new SessionProcessMonitor({
    probe,
    setTimeout: (callback, delayMs) => { confirmations.push({ delayMs, run: callback }); return confirmations.length; },
    onProcessEnded: (observation) => ended.push(observation.agentId),
  });
  const service = new SessionLifecycleService({
    fleet,
    monitor,
    settlement: { settleCleared: (agentId) => settled.push(agentId) },
    lockPathFor: () => LOCK,
  });
  return { fleet, lease, monitor, service, ended, settled, confirmations };
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

test("a launch whose marker never appears is left to the startup proof", () => {
  // The wrapper takes a moment to start; a missing marker here means "not yet".
  const { monitor, ended } = setup(() => false);
  monitor.trackLaunch({ agentId: agent("a1"), sessionId: session("s1"), lockFile: LOCK });
  monitor.poll();
  monitor.poll();
  assert.deepEqual(ended, []);
  assert.equal(monitor.isTracked(agent("a1")), true);
});

test("a CLI that exits before its first hook is reported as a failed launch", () => {
  // Bad flag, auth wall, a session id --resume refuses: the marker appears with
  // the wrapper, then goes when the CLI gives up, and no SessionStart ever runs.
  let alive = true;
  const phases: string[] = [];
  const monitor = new SessionProcessMonitor({
    probe: () => alive,
    onProcessEnded: (observation) => phases.push(observation.phase),
  });
  monitor.trackLaunch({ agentId: agent("a1"), sessionId: session("s1"), lockFile: LOCK });
  monitor.poll();
  alive = false;
  monitor.poll();
  assert.deepEqual(phases, ["launching"]);
  assert.equal(monitor.isTracked(agent("a1")), false);
});

test("once a session is proven, its death is an ordinary ending", () => {
  const { fleet, monitor, service, ended } = setup(() => false);
  registerAgent(fleet, agent("a1"), session("s1"));
  monitor.trackLaunch({ agentId: agent("a1"), sessionId: session("s1"), lockFile: LOCK });
  // SessionStart proves a TUI existed, so a marker already gone means dead —
  // waiting to have seen it ourselves would strand the agent.
  service.sessionStarted(start);
  monitor.poll();
  assert.deepEqual(ended, [agent("a1")]);
});

test("an unproven launch is not live for lease recovery", () => {
  const { monitor } = setup(() => true);
  monitor.trackLaunch({ agentId: agent("a1"), sessionId: session("s1"), lockFile: LOCK });
  assert.equal(monitor.observe(agent("a1")), "missing");
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

test("session-end process-exit reasons are left to the marker, still present while the hook runs", () => {
  const { fleet, monitor, service, settled } = setup(() => true);
  registerAgent(fleet, agent("a1"), session("s1"));
  service.sessionStarted(start);
  assert.equal(service.sessionEnded({ agentId: agent("a1"), sessionId: session("s1"), reason: "prompt_input_exit" }), false);
  assert.equal(monitor.isTracked(agent("a1")), true);
  assert.deepEqual(settled, []);
});

test("a reported process exit confirms within milliseconds instead of waiting for the interval", () => {
  // The hook runs inside the dying process, so the marker outlives the report.
  let alive = true;
  const { fleet, service, confirmations, ended } = setup(() => alive);
  registerAgent(fleet, agent("a1"), session("s1"));
  service.sessionStarted(start);
  service.sessionEnded({ agentId: agent("a1"), sessionId: session("s1"), reason: "prompt_input_exit" });
  assert.ok(confirmations.length > 1);
  assert.ok(confirmations[0]!.delayMs < 100, "first confirmation sweep is sub-100ms");
  confirmations[0]!.run();
  assert.deepEqual(ended, [], "the marker was still there");
  alive = false;
  confirmations[1]!.run();
  assert.deepEqual(ended, [agent("a1")]);
  // A settled agent drops out, so the remaining ladder is a no-op.
  for (const confirmation of confirmations.slice(2)) confirmation.run();
  assert.deepEqual(ended, [agent("a1")]);
});

test("the confirmation ladder is not armed for agents nothing is watching", () => {
  const { fleet, service, confirmations } = setup(() => true);
  registerAgent(fleet, agent("a1"), session("s1"));
  service.sessionEnded({ agentId: agent("a1"), sessionId: session("s1"), reason: "logout" });
  assert.deepEqual(confirmations, []);
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
