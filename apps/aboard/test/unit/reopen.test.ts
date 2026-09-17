import assert from "node:assert/strict";
import test from "node:test";

import { ReopenCoordinator, describeReopenOutcome } from "../../src/platform/reopen.js";
import type { AgentId, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";

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
  assert.equal(option?.resumable, false);
  assert.equal(option?.reason, "inspection-failed");
  assert.match(option?.diagnostic ?? "", /failed to decode rollout/u);
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

test("interactive delegated continuations refuse a live terminal and require a next message after exit", async () => {
  let live: TerminalId | undefined = "terminal-1" as TerminalId;
  const coordinator = new ReopenCoordinator({
    activity: { entries: endedActivity }, fleet: new FleetRegistry(),
    terminals: { isOpen: () => live !== undefined, liveTerminalFor: () => live,
      show: () => assert.fail("a continuation must not focus the child") },
    launcher: { reopen: async () => { throw new Error("must not launch without a message"); } },
    isResumable: async () => true,
  });
  const candidate = { platform: "claude" as const, agentId, type: "general" as const,
    executionMode: "interactive" as const, sessionId, description: "general", origin: "ended" as const, at };
  assert.deepEqual(await coordinator.reopen(candidate), { action: "unresumable", candidate, reason: "execution-active" });
  live = undefined;
  assert.deepEqual(await coordinator.reopen(candidate), { action: "unresumable", candidate, reason: "next-message-required" });
});
