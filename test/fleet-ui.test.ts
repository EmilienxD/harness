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

test("tree mapping is hierarchical and includes lifecycle, telemetry, elapsed time, and lease", () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); let refreshes = 0;
  const model = new FleetTreeModel(fleet, lease, { refresh: () => refreshes++ }, () => new Date("2026-07-30T10:02:05.000Z"));
  fleet.register(worker, startedAt); fleet.transition(worker.identity.agentId, { status: "running", startedAt }, startedAt);
  fleet.startChild({ agentId: "child-1", parentAgentId: worker.identity.agentId, type: "Explore", status: "running", startedAt, telemetry: { totalTokens: 400, totalDurationMs: 1, totalToolUseCount: 2, compactionCount: 0 } }, startedAt);
  lease.acquire("write-capable", { agentId: worker.identity.agentId, sessionId: worker.sessionId }, startedAt, "test");
  const root = model.roots()[0]!; const item = model.item(root);
  assert.equal(item.label, "implementer #19"); assert.match(item.description, /running · lease holder · 2:05 · compacted ×1/);
  assert.equal(model.children(root).length, 1); assert.ok(refreshes >= 4); model.dispose();
});

test("commands route focus, send, kill, resume, and force release", async () => {
  const fleet = new FleetRegistry(); const lease = new WriteLease(); fleet.register(worker, startedAt); lease.acquire("write-capable", { agentId: worker.identity.agentId, sessionId: worker.sessionId }, startedAt, "test");
  const callbacks = new Map<string, (...args: readonly unknown[]) => unknown>(); const calls: string[] = [];
  const registration = registerFleetCommands({ register: (name, callback) => { callbacks.set(name, callback); return { dispose: () => callbacks.delete(name) }; }, input: async () => "hello", confirm: async () => true, info: () => {}, error: () => {} }, { show: () => calls.push("show"), kill: () => calls.push("kill"), sendUserTakeoverText: (_id, text) => calls.push(`send:${text}`) }, fleet, lease, () => new Date("2026-07-30T10:03:00.000Z"));
  const node = { kind: "agent" as const, session: worker, leaseHolder: true };
  await callbacks.get("aboard.focusAgent")?.(node); await callbacks.get("aboard.sendAgent")?.(node); await callbacks.get("aboard.killAgent")?.(node); await callbacks.get("aboard.resumeAgent")?.(node); await callbacks.get("aboard.forceReleaseLease")?.();
  assert.deepEqual(calls, ["show", "send:hello", "kill", "show"]); assert.equal(lease.current(), undefined); registration.dispose(); assert.equal(callbacks.size, 0);
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
