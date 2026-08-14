import assert from "node:assert/strict";
import test from "node:test";

import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";
import { FleetNotifications, FleetTreeModel, registerFleetCommands, renderFleetStatus, saveLeaseWarning } from "../src/vscode/fleet.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;
const startedAt = at("2026-07-30T10:00:00.000Z");
const worker: AgentSession = { identity: { agentId: agent("worker-1"), type: "implementer" }, sessionId: session("session-1"), terminal: { terminalId: terminal("terminal-1"), name: "worker" }, lifecycle: { status: "starting", startedAt }, resultDelivery: { mode: "tool-result" }, telemetry: { totalTokens: 1200, totalDurationMs: 3000, totalToolUseCount: 4, compactionCount: 1 }, issueNumber: 19 };

test("tree mapping is hierarchical and shows status, elapsed time, and lease but no telemetry", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); let refreshes = 0;
  const model = new FleetTreeModel(fleet, lease, { refresh: () => refreshes++ }, () => new Date("2026-07-30T10:02:05.000Z"));
  fleet.register(worker, startedAt); fleet.transition(worker.identity.agentId, { status: "running", startedAt }, startedAt);
  fleet.startChild({ agentId: "child-1", parentAgentId: worker.identity.agentId, type: "Explore", status: "running", startedAt, telemetry: { totalTokens: 400, totalDurationMs: 1, totalToolUseCount: 2, compactionCount: 0 } }, startedAt);
  lease.acquire("write-capable", { agentId: worker.identity.agentId, sessionId: worker.sessionId }, startedAt, "test");
  const root = model.roots()[0]!; const item = model.item(root);
  assert.equal(item.label, "implementer #19"); assert.equal(item.description, "running · lease holder · 2:05");
  assert.equal(item.tooltip, "Session: session-1\nStatus: running\nHolds the write lease");
  const [child] = model.children(root);
  assert.equal(child !== undefined && model.item(child).description, "running");
  assert.equal(child !== undefined && model.item(child).tooltip, "Type: Explore\nStatus: running");
  assert.ok(refreshes >= 4); model.dispose();
});

test("one section lists the Manager and its workers, with the Manager pinned first", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease();
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} }, () => new Date("2026-07-30T10:02:05.000Z"));
  assert.deepEqual(model.roots(), []);
  // Workers with no Manager are a valid state, so the section is not empty then
  // and its welcome actions are unavailable — the view title menu carries them.
  fleet.register(worker, startedAt);
  assert.equal(model.roots().length, 1);
  fleet.register({ ...worker, identity: { agentId: agent("manager-1"), type: "manager" }, sessionId: session("session-2"), resultDelivery: { mode: "none" } }, startedAt);
  const types = model.roots().map((node) => node.kind === "agent" ? node.session.identity.type : "child");
  assert.deepEqual(types, ["manager", "implementer"]);
  model.dispose();
});

test("icons separate the Manager, interactive agents, and automated workers, never the lease", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease();
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} }, () => new Date("2026-07-30T10:02:05.000Z"));
  const icon = (type: AgentSession["identity"]["type"], id: string, sessionId: string) => {
    fleet.register({ ...worker, identity: { agentId: agent(id), type }, sessionId: session(sessionId) }, startedAt);
    return model.item({ kind: "agent", session: fleet.get(agent(id))!, leaseHolder: true }).icon;
  };
  assert.equal(icon("manager", "m", "s-m"), "organization");
  // An interactive brainstormer is still something the user talks to.
  assert.equal(icon("brainstormer", "b", "s-b"), "comment-discussion");
  assert.equal(icon("implementer", "i", "s-i"), "lock");
  assert.equal(icon("pr-doctor-afk", "v", "s-v"), "lock");
  assert.equal(icon("pr-doctor-hitl", "f", "s-f"), "comment-discussion");
  // The dual-mode builtin types follow the launch: an automated one is closed
  // to input, an interactive one (delivery mode "none") is something the user
  // talks to.
  assert.equal(icon("general-purpose", "g", "s-g"), "lock");
  assert.equal(icon("Explore", "e", "s-e"), "lock");
  fleet.register({ ...worker, identity: { agentId: agent("e2"), type: "Explore" }, sessionId: session("s-e2"), resultDelivery: { mode: "none" } }, startedAt);
  assert.equal(model.item({ kind: "agent", session: fleet.get(agent("e2"))!, leaseHolder: false }).icon, "comment-discussion");
  model.dispose();
});

test("commands route focus and kill, and force release stays available as a recovery hatch", async () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); fleet.register(worker, startedAt); lease.acquire("write-capable", { agentId: worker.identity.agentId, sessionId: worker.sessionId }, startedAt, "test");
  const callbacks = new Map<string, (...args: readonly unknown[]) => unknown>(); const calls: string[] = [];
  const registration = registerFleetCommands({ register: (name, callback) => { callbacks.set(name, callback); return { dispose: () => callbacks.delete(name) }; }, confirm: async () => true, info: () => {}, error: () => {} }, { show: () => calls.push("show"), kill: () => calls.push("kill") }, fleet, lease, () => new Date("2026-07-30T10:03:00.000Z"));
  const node = { kind: "agent" as const, session: worker, leaseHolder: true };
  await callbacks.get("aboard.focusAgent")?.(node); await callbacks.get("aboard.killAgent")?.(node); await callbacks.get("aboard.forceReleaseLease")?.();
  assert.deepEqual(calls, ["show", "kill"]); assert.equal(lease.current(), undefined);
  assert.deepEqual([...callbacks.keys()], ["aboard.focusAgent", "aboard.killAgent", "aboard.removePausedSession", "aboard.forceReleaseLease"]);
  registration.dispose(); assert.equal(callbacks.size, 0);
});

test("paused rows explain restoration instead of controlling a missing terminal", async () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); fleet.register(worker, startedAt);
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} }, () => new Date("2026-07-30T10:02:05.000Z"), () => false);
  const item = model.item(model.roots()[0]!);
  assert.match(item.description, /^paused/);
  assert.match(item.tooltip, /Restore Fleet/);
  assert.equal(item.contextValue, "aboard.agent.paused");
  const callbacks = new Map<string, (...args: readonly unknown[]) => unknown>(); const info: string[] = []; const calls: string[] = [];
  const registration = registerFleetCommands({ register: (name, callback) => { callbacks.set(name, callback); return { dispose: () => callbacks.delete(name) }; }, confirm: async () => true, info: (message) => info.push(message), error: () => {} }, { show: () => calls.push("show"), kill: () => calls.push("kill"), isOpen: () => false }, fleet, lease);
  const node = { kind: "agent" as const, session: worker, leaseHolder: false };
  await callbacks.get("aboard.focusAgent")?.(node); await callbacks.get("aboard.killAgent")?.(node); await callbacks.get("aboard.removePausedSession")?.(node);
  assert.deepEqual(calls, []); assert.equal(info.length, 3); assert.equal(fleet.get(worker.identity.agentId), undefined);
  registration.dispose(); model.dispose();
});

test("status and typed notifications render domain state without sensitive content", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); const info: string[] = []; const errors: string[] = [];
  const notifications = new FleetNotifications(fleet, { information: (message) => info.push(message), warning: () => {}, error: (message) => errors.push(message) });
  fleet.register(worker, startedAt); fleet.transition(worker.identity.agentId, { status: "running", startedAt }, startedAt); lease.acquire("write-capable", { agentId: worker.identity.agentId, sessionId: worker.sessionId }, startedAt, "test");
  assert.deepEqual(renderFleetStatus(4823, fleet, lease), { text: "$(organization) 1 · :4823 · $(lock) worker-1", tooltip: "aboard bridge: 127.0.0.1:4823\nLive agents: 1\nWrite lease: worker-1", liveAgentCount: 1 });
  assert.match(saveLeaseWarning(lease) ?? "", /saved.*worker-1.*may conflict/);
  const finishedAt = at("2026-07-30T10:05:00.000Z"); fleet.transition(worker.identity.agentId, { status: "failed", startedAt, finishedAt, failure: { type: "timeout", exitCode: null, lastAssistantMessage: "secret prompt" } }, finishedAt);
  assert.deepEqual(errors, ["implementer failed: timeout."]); assert.equal(info.length, 0); notifications.dispose();
});
