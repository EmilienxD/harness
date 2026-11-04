import assert from "node:assert/strict";
import test from "node:test";

import { ReopenCoordinator, describeReopenOutcome } from "../../src/platform/reopen.js";
import type { AgentId, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";

test("an open terminal is omitted from reopen until a user message starts its conversation", async () => {
  const fleet = new FleetRegistry();
  fleet.register({
    platform: "pi", identity: { agentId, type: "interactive" }, sessionId, sessionBinding: "bound",
    terminal: { terminalId: "empty" as TerminalId, name: "Pi" },
    lifecycle: { status: "starting", startedAt: at }, resultDelivery: { mode: "none" },
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  }, at);
  let started = false;
  const coordinator = new ReopenCoordinator({
    activity: { entries: () => ({ version: 1, entries: [] }) }, fleet,
    terminals: { isOpen: () => true, liveTerminalFor: () => "empty" as TerminalId, show() {} },
    launcher: { reopen: async () => { throw new Error("must not launch"); } },
    isResumable: async () => started,
  });
  assert.deepEqual(await coordinator.list(), []);
  started = true;
  assert.equal((await coordinator.list()).length, 1);
});

const agentId = "interactive-1" as AgentId;
const sessionId = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;
const at = "2026-09-08T10:00:00.000Z" as IsoTimestamp;

function endedActivity() {
  return { version: 1 as const, entries: [{
    kind: "agent" as const, id: "agent:interactive-1:ended", at, agentId, type: "interactive" as const,
    description: "ChatGPT", outcome: "ended" as const,
    reopen: { platform: "chatgpt" as const, sessionId },
  }] };
}

test("reopening an already-open session focuses its one terminal without launching a duplicate", async () => {
  const shown: TerminalId[] = [];
  let launched = 0;
  const coordinator = new ReopenCoordinator({
    activity: { entries: endedActivity }, fleet: new FleetRegistry(),
    terminals: {
      isOpen: () => true,
      liveTerminalFor: () => "terminal-1" as TerminalId,
      show: (terminalId) => shown.push(terminalId),
    },
    launcher: { reopen: async () => { launched += 1; throw new Error("must not launch"); } },
    isResumable: async () => true,
  });

  const outcome = await coordinator.reopen({
    platform: "chatgpt", agentId, type: "interactive", sessionId, description: "ChatGPT", origin: "ended", at,
  });
  assert.equal(outcome.action, "focused");
  assert.deepEqual(shown, ["terminal-1"]);
  assert.equal(launched, 0);
});

test("conversation inspection failures remain actionable instead of looking like a missing session", async () => {
  const coordinator = new ReopenCoordinator({
    activity: { entries: endedActivity }, fleet: new FleetRegistry(),
    terminals: { isOpen: () => false, liveTerminalFor: () => undefined, show: () => undefined },
    launcher: { reopen: async () => { throw new Error("must not launch"); } },
    isResumable: async () => { throw new Error("Codex could not read its saved state (failed to decode rollout)"); },
  });

  const option = (await coordinator.list())[0];
  // Listing uses display metadata; inspection is deferred until selection.
  assert.equal(option?.resumable, true);
  assert.equal(option?.reason, undefined);
  const outcome = await coordinator.reopenLatest();
  assert.equal(outcome.action, "unresumable");
  assert.match(describeReopenOutcome(outcome), /failed to decode rollout/u);

  // Reopening one candidate directly answers with the same diagnosis rather
  // than a raw platform error every caller would have to translate again.
  const direct = await coordinator.reopen({
    platform: "chatgpt", agentId, type: "interactive", sessionId, description: "ChatGPT", origin: "ended", at,
  });
  assert.equal(direct.action, "unresumable");
  assert.equal(direct.action === "unresumable" ? direct.reason : undefined, "inspection-failed");
  assert.match(describeReopenOutcome(direct), /failed to decode rollout/u);
});

test("reopening workers and delegated sessions waits for user input in an interactive terminal", async () => {
  const targets: import("../../src/bridge/delegation.js").ReopenTarget[] = [];
  const coordinator = new ReopenCoordinator({
    activity: { entries: endedActivity }, fleet: new FleetRegistry(),
    terminals: { isOpen: () => false, liveTerminalFor: () => undefined, show: () => undefined },
    launcher: { reopen: async (target) => {
      targets.push(target);
      return { agentId, sessionId, terminalId: "terminal-2" as TerminalId };
    } },
    isResumable: async () => true,
  });
  const candidate = { platform: "claude" as const, agentId, sessionId, description: "worker", origin: "ended" as const, at };
  for (const session of [
    { type: "address" as const, executionMode: "auto-run" as const },
    { type: "general" as const, executionMode: "auto" as const },
    { type: "general" as const, executionMode: "interactive" as const },
  ]) {
    const outcome = await coordinator.reopen({ ...candidate, ...session });
    assert.equal(outcome.action, "reopened");
    const target = targets.at(-1)!;
    assert.equal(target.executionMode, "interactive");
    assert.equal(target.preserveSessionModel, true);
    assert.equal(target.prompt, undefined);
    assert.equal(target.sessionId, sessionId);
    assert.equal(target.type, session.type);
    assert.match(describeReopenOutcome(outcome), /handed it back to you/u);
  }
});
