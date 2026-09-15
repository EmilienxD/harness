import assert from "node:assert/strict";
import test from "node:test";

import { closeSettledAutoRunTerminal } from "../../src/auto/terminal-cleanup.js";
import type { TerminalSnapshot } from "../../src/platform/terminals.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";

const at = (value: string) => value as IsoTimestamp;
const agentId = "1" as AgentId;
const sessionId = "session-1" as SessionId;
const terminalId = "terminal-1" as TerminalId;
const startedAt = at("2026-08-23T10:00:00.000Z");

function session(): AgentSession {
  return {
    platform: "claude",
    identity: { agentId, type: "implementer" },
    sessionId,
    sessionBinding: "bound",
    terminal: { terminalId, name: "aboard: address issue 206" },
    lifecycle: { status: "starting", startedAt },
    resultDelivery: { mode: "tool-result" },
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  };
}

function snapshot(status: TerminalSnapshot["status"] = "open"): TerminalSnapshot {
  return {
    terminalId,
    agentId,
    sessionId,
    agentType: "implementer",
    name: "aboard: address issue 206",
    cwd: "C:\\project",
    status,
    createdAt: startedAt,
    closedAt: null,
    exitCode: null,
  };
}

test("auto-run terminal cleanup removes a completed worker from the fleet", () => {
  const fleet = new FleetRegistry();
  fleet.register(session(), startedAt);
  fleet.transition(agentId, { status: "running", startedAt }, startedAt);
  fleet.transition(agentId, { status: "completed", startedAt, finishedAt: at("2026-08-23T10:05:00.000Z"), exitCode: 0, lastAssistantMessage: "done" }, at("2026-08-23T10:05:00.000Z"));
  const killed: TerminalId[] = [];

  closeSettledAutoRunTerminal(
    { get: () => snapshot(), kill: (id) => killed.push(id) },
    fleet,
    terminalId,
    () => new Date("2026-08-23T10:06:00.000Z"),
  );

  assert.deepEqual(killed, [terminalId]);
  assert.equal(fleet.get(agentId), undefined);
});

test("auto-run terminal cleanup leaves a running interactive worker for close reconciliation", () => {
  const fleet = new FleetRegistry();
  fleet.register(session(), startedAt);
  fleet.transition(agentId, { status: "running", startedAt }, startedAt);

  closeSettledAutoRunTerminal(
    { get: () => snapshot(), kill: () => {} },
    fleet,
    terminalId,
    () => new Date("2026-08-23T10:06:00.000Z"),
  );

  assert.equal(fleet.get(agentId)?.lifecycle.status, "running");
});

test("auto-run cleanup retires a settled row when the terminal was already closed", () => {
  const fleet = new FleetRegistry();
  fleet.register(session(), startedAt);
  fleet.transition(agentId, { status: "running", startedAt }, startedAt);
  fleet.transition(agentId, { status: "completed", startedAt, finishedAt: at("2026-08-23T10:05:00.000Z"), exitCode: 0, lastAssistantMessage: "done" }, at("2026-08-23T10:05:00.000Z"));

  closeSettledAutoRunTerminal(
    { get: () => snapshot("closed"), kill: () => assert.fail("an already closed terminal must not be killed again") },
    fleet,
    terminalId,
    () => new Date("2026-08-23T10:06:00.000Z"),
  );

  assert.equal(fleet.get(agentId), undefined);
});
