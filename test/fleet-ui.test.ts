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
const worker: AgentSession = { identity: { agentId: agent("4"), type: "implementer" }, sessionId: session("session-1"), terminal: { terminalId: terminal("terminal-1"), name: "worker" }, lifecycle: { status: "starting", startedAt }, resultDelivery: { mode: "tool-result" }, telemetry: { totalTokens: 1200, totalDurationMs: 3000, totalToolUseCount: 4, compactionCount: 1 }, issueNumbers: [19] };

test("tree mapping is hierarchical and shows status and lease but no telemetry", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); let refreshes = 0;
  const model = new FleetTreeModel(fleet, lease, { refresh: () => refreshes++ });
  fleet.register(worker, startedAt); fleet.transition(worker.identity.agentId, { status: "running", startedAt }, startedAt);
  fleet.startChild({ agentId: "child-1", parentAgentId: worker.identity.agentId, type: "Explore", status: "running", startedAt, telemetry: { totalTokens: 400, totalDurationMs: 1, totalToolUseCount: 2, compactionCount: 0 } }, startedAt);
  lease.acquire("write-capable", { agentId: worker.identity.agentId, sessionId: worker.sessionId }, startedAt, "test");
  const root = model.roots()[0]!; const item = model.item(root);
  assert.equal(item.label, "aboard-implementer-4 #19"); assert.equal(item.description, "running · lease holder");
  assert.equal(item.tooltip, "Session: session-1\nStatus: running\nHolds the write lease");
  const [child] = model.children(root);
  assert.equal(child !== undefined && model.item(child).description, "running");
  assert.equal(child !== undefined && model.item(child).tooltip, "Type: Explore\nStatus: running");
  assert.ok(refreshes >= 4); model.dispose();
});

test("the row is named the running session's aboard-<type>-<id>, not the bare type", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease();
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} });
  // Three workers of one type stay distinguishable by the number the terminal's
  // `@aboard-implementer-N` banner shows; a pre-numeric UUID id is shown as-is.
  fleet.register({ ...worker, identity: { agentId: agent("4"), type: "implementer" }, sessionId: session("s-4") }, startedAt);
  fleet.register({ ...worker, identity: { agentId: agent("5"), type: "implementer" }, sessionId: session("s-5") }, startedAt);
  fleet.register({ ...worker, identity: { agentId: agent("9f2c1d3a-0000-4000-8000-000000000000"), type: "implementer" }, sessionId: session("s-uuid") }, startedAt);
  fleet.register({ ...worker, identity: { agentId: agent("7"), type: "webresearcher" }, sessionId: session("s-7") }, startedAt);
  fleet.register({ ...worker, identity: { agentId: agent("1"), type: "manager" }, sessionId: session("s-m"), resultDelivery: { mode: "none" } }, startedAt);
  const labels = model.roots().map((node) => model.item(node).label);
  // The spreads carry the worker's issue numbers onto every row; the assertion
  // is the session-name prefix, not which issues each happens to inherit.
  assert.deepEqual(labels, [
    "Manager #19",
    "aboard-implementer-4 #19",
    "aboard-implementer-5 #19",
    "aboard-implementer-9f2c1d3a-0000-4000-8000-000000000000 #19",
    "aboard-webresearcher-7 #19",
  ]);
  model.dispose();
});

test("a row names every issue its launch was bound to", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease();
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} });
  fleet.register({ ...worker, identity: { agentId: agent("worker-2"), type: "general-purpose" }, issueNumbers: [12, 14] }, startedAt);
  assert.equal(model.item(model.roots()[0]!).label, "aboard-general-purpose-worker-2 #12, #14");
  model.dispose();
});

test("one section lists the Manager and its workers, with the Manager pinned first", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease();
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} });
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

test("New Manager stays pinned above workers and is replaced by the live Manager", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease();
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} }, () => true, () => fleet.list().some((entry) => entry.identity.type === "manager"));
  fleet.register(worker, startedAt);
  const action = model.roots()[0]!;
  assert.equal(action.kind, "new-manager");
  assert.deepEqual(model.item(action), {
    label: "New Manager",
    description: "",
    tooltip: "Start a new Manager",
    icon: "add",
    contextValue: "aboard.action.newManager",
    collapsible: false,
    command: { command: "aboard.newManager", title: "New Manager", arguments: [] },
  });

  fleet.register({ ...worker, identity: { agentId: agent("manager-1"), type: "manager" }, sessionId: session("session-2"), resultDelivery: { mode: "none" } }, startedAt);
  const roots = model.roots();
  assert.equal(roots.some((node) => node.kind === "new-manager"), false);
  assert.equal(roots[0]?.kind === "agent" && roots[0].session.identity.type, "manager");
  assert.deepEqual(roots.map((node) => model.item(node).label), ["Manager #19", "aboard-implementer-4 #19"]);
  model.dispose();
});

test("icons separate the Manager, interactive agents, and automated workers, never the lease", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease();
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} });
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
  assert.deepEqual([...callbacks.keys()], ["aboard.focusAgent", "aboard.killAgent", "aboard.forceReleaseLease"]);
  registration.dispose(); assert.equal(callbacks.size, 0);
});

test("a session whose terminal is gone leaves the view entirely", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); fleet.register(worker, startedAt);
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} }, () => false);
  assert.deepEqual(model.roots(), []);
  model.dispose();
});

test("a finished session never renders, even while its terminal is still open", () => {
  // Completed and failed may exist in the domain for a moment while a result
  // reaches its caller. Agents describes what is running, so neither shows here.
  const fleet = new FleetRegistry(); const lease = new WriteLease();
  fleet.register(worker, startedAt);
  const finishedAt = at("2026-07-30T10:05:00.000Z");
  fleet.transition(worker.identity.agentId, { status: "completed", startedAt, finishedAt, exitCode: 0, lastAssistantMessage: "done" }, finishedAt);
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} }, () => true);
  assert.deepEqual(model.roots(), []);
  model.dispose();
});

test("a live row is focusable and says only what is true of a running agent", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); fleet.register(worker, startedAt);
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} }, () => true);
  const item = model.item(model.roots()[0]!);
  assert.equal(item.contextValue, "aboard.agent.active");
  assert.equal(item.command?.command, "aboard.focusAgent");
  assert.doesNotMatch(item.description, /paused|terminal closed|interrupted/);
  assert.doesNotMatch(item.tooltip, /Restore Fleet/);
  model.dispose();
});

test("only running children render under an agent", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); fleet.register(worker, startedAt);
  const child = { parentAgentId: worker.identity.agentId, type: "Explore", startedAt, telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 } };
  fleet.startChild({ ...child, agentId: "child-1", status: "running" }, startedAt);
  fleet.startChild({ ...child, agentId: "child-2", status: "running" }, startedAt);
  fleet.finishChild(worker.identity.agentId, "child-2", "done", startedAt);
  const model = new FleetTreeModel(fleet, lease, { refresh: () => {} }, () => true);
  const root = model.roots()[0]!;
  assert.deepEqual(model.children(root).map((node) => node.kind === "child" ? node.child.agentId : ""), ["child-1"]);
  assert.equal(model.item(root).collapsible, true);
  model.dispose();
});

test("status and typed notifications render domain state without sensitive content", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); const info: string[] = []; const errors: string[] = [];
  const notifications = new FleetNotifications(fleet, { information: (message) => info.push(message), warning: () => {}, error: (message) => errors.push(message) });
  fleet.register(worker, startedAt); fleet.transition(worker.identity.agentId, { status: "running", startedAt }, startedAt); lease.acquire("write-capable", { agentId: worker.identity.agentId, sessionId: worker.sessionId }, startedAt, "test");
  assert.deepEqual(renderFleetStatus(4823, fleet, lease), { text: "$(organization) 1 · :4823 · $(lock) 4", tooltip: "aboard bridge: 127.0.0.1:4823\nLive agents: 1\nWrite lease: 4", liveAgentCount: 1 });
  assert.match(saveLeaseWarning(lease) ?? "", /saved.*4.*may conflict/);
  assert.equal(renderFleetStatus(4823, fleet, lease, () => false).liveAgentCount, 0, "paused records are not live terminals");
  const finishedAt = at("2026-07-30T10:05:00.000Z"); fleet.transition(worker.identity.agentId, { status: "failed", startedAt, finishedAt, failure: { type: "timeout", exitCode: null, lastAssistantMessage: "secret prompt" } }, finishedAt);
  assert.deepEqual(errors, ["implementer failed: timeout."]); assert.equal(info.length, 0); notifications.dispose();
});
