import assert from "node:assert/strict";
import test from "node:test";

import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import { WriteLease } from "../../src/domain/lease.js";
import { FleetTreeModel } from "../../src/vscode/fleet.js";

const timestamp = "2026-09-17T10:00:00.000Z" as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;

function liveSession(
  agentId: AgentId,
  platform: AgentSession["platform"],
  executionMode: NonNullable<AgentSession["executionMode"]>,
  type: AgentSession["identity"]["type"] = executionMode === "interactive" ? "interactive" : "general",
): AgentSession {
  return {
    platform,
    identity: { agentId, type },
    sessionId: session(`session-${agentId}`),
    sessionBinding: "bound",
    terminal: { terminalId: terminal(`terminal-${agentId}`), name: `aboard: ${agentId}` },
    lifecycle: { status: "starting", startedAt: timestamp },
    resultDelivery: { mode: "none" },
    executionMode,
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  };
}

test("fleet rows distinguish execution mode and provider independently of the write lease", () => {
  const interactiveId = agent("interactive-claude");
  const backgroundId = agent("background-codex");
  const fleet = new FleetRegistry();
  fleet.register(liveSession(interactiveId, "claude", "interactive"), timestamp);
  fleet.register(liveSession(backgroundId, "chatgpt", "auto"), timestamp);
  fleet.transition(interactiveId, { status: "running", startedAt: timestamp }, timestamp);
  fleet.transition(backgroundId, { status: "running", startedAt: timestamp }, timestamp);

  const lease = new WriteLease();
  lease.acquire(
    "write-capable",
    { agentId: interactiveId, sessionId: session(`session-${interactiveId}`) },
    timestamp,
    "independent presentation check",
  );
  const model = new FleetTreeModel(fleet, lease, { refresh() {} }, () => true);
  const rows = new Map(model.roots().map((node) => [node.session.identity.agentId, model.item(node)]));

  assert.deepEqual(
    { icon: rows.get(interactiveId)?.icon, description: rows.get(interactiveId)?.description, tooltip: rows.get(interactiveId)?.tooltip },
    {
      icon: "eye",
      description: "Claude · running · lease holder",
      tooltip: "Provider: Claude\nMode: Interactive\nSession: session-interactive-claude\nStatus: running\nHolds the write lease",
    },
  );
  assert.deepEqual(
    { icon: rows.get(backgroundId)?.icon, description: rows.get(backgroundId)?.description, tooltip: rows.get(backgroundId)?.tooltip },
    {
      icon: "eye-closed",
      description: "Codex · running",
      tooltip: "Provider: Codex\nMode: Background\nSession: session-background-codex\nStatus: running",
    },
  );
  model.dispose();
});

test("only interactive fleet rows offer terminal focus", () => {
  const interactiveId = agent("interactive-claude");
  const backgroundId = agent("background-codex");
  const fleet = new FleetRegistry();
  fleet.register(liveSession(interactiveId, "claude", "interactive"), timestamp);
  fleet.register(liveSession(backgroundId, "chatgpt", "auto"), timestamp);
  fleet.transition(interactiveId, { status: "running", startedAt: timestamp }, timestamp);
  fleet.transition(backgroundId, { status: "running", startedAt: timestamp }, timestamp);
  const model = new FleetTreeModel(fleet, new WriteLease(), { refresh() {} }, () => true);
  const rows = new Map(model.roots().map((node) => [node.session.identity.agentId, model.item(node)]));

  assert.equal(rows.get(interactiveId)?.contextValue, "aboard.agent.interactive");
  assert.equal(rows.get(interactiveId)?.command?.command, "aboard.focusAgent");
  assert.equal(rows.get(backgroundId)?.contextValue, "aboard.agent.background");
  assert.equal(rows.get(backgroundId)?.command, undefined);
  model.dispose();
});

test("an Auto Run worker row stays focusable while its exploration row does not", () => {
  const addressId = agent("auto-run-address");
  const exploreId = agent("auto-run-explore");
  const fleet = new FleetRegistry();
  fleet.register(liveSession(addressId, "claude", "auto-run", "address"), timestamp);
  fleet.register(liveSession(exploreId, "claude", "auto-run", "explore"), timestamp);
  fleet.transition(addressId, { status: "running", startedAt: timestamp }, timestamp);
  fleet.transition(exploreId, { status: "running", startedAt: timestamp }, timestamp);
  const model = new FleetTreeModel(fleet, new WriteLease(), { refresh() {} }, () => true);
  const rows = new Map(model.roots().map((node) => [node.session.identity.agentId, model.item(node)]));

  assert.equal(rows.get(addressId)?.icon, "eye");
  assert.equal(rows.get(addressId)?.contextValue, "aboard.agent.interactive");
  assert.equal(rows.get(addressId)?.command?.command, "aboard.focusAgent");
  assert.equal(rows.get(exploreId)?.icon, "eye-closed");
  assert.equal(rows.get(exploreId)?.contextValue, "aboard.agent.background");
  assert.equal(rows.get(exploreId)?.command, undefined);
  model.dispose();
});
