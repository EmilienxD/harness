import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_LEDGER_LIMIT,
  endedSessionFrom,
  isLedgerRecordable,
  isReopenableType,
  recordEndedSession,
  reopenCandidates,
  type EndedSessionRecord,
  type SessionLedgerDto,
} from "../src/domain/session-ledger.js";
import { parseSessionLedgerDto } from "../src/domain/validation.js";
import type { AgentId, AgentSession, AgentType, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const terminal = (value: string) => value as TerminalId;
const telemetry = { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 };

const SESSIONS = [
  "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee",
  "af817a6c-cd41-41e2-a4db-44d3f43cd560",
  "c15badb6-d6c8-45a6-a59f-e931cd364332",
] as const;

function fleetSession(overrides: {
  readonly agentId: string;
  readonly type: AgentType;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly terminalId?: string;
  readonly name?: string;
  readonly delivers?: AgentSession["resultDelivery"];
  readonly issueNumbers?: readonly number[];
  readonly chromeEnabled?: true;
}): AgentSession {
  return {
    identity: { agentId: agent(overrides.agentId), type: overrides.type },
    sessionId: overrides.sessionId as SessionId,
    terminal: { terminalId: terminal(overrides.terminalId ?? `terminal-${overrides.agentId}`), name: overrides.name ?? `aboard: ${overrides.type} work` },
    lifecycle: { status: "running", startedAt: at(overrides.startedAt) },
    resultDelivery: overrides.delivers ?? { mode: "none" },
    telemetry,
    ...(overrides.issueNumbers === undefined ? {} : { issueNumbers: overrides.issueNumbers }),
    ...(overrides.chromeEnabled === undefined ? {} : { chromeEnabled: overrides.chromeEnabled }),
  };
}

function ended(overrides: {
  readonly agentId: string;
  readonly type?: AgentType;
  readonly sessionId?: string;
  readonly endedAt: string;
  readonly description?: string;
}): EndedSessionRecord {
  return {
    agentId: agent(overrides.agentId),
    type: overrides.type ?? "brainstormer",
    sessionId: (overrides.sessionId ?? SESSIONS[0]) as SessionId,
    description: overrides.description ?? "spec for offline sync",
    startedAt: at("2026-07-30T09:00:00.000Z"),
    endedAt: at(overrides.endedAt),
  };
}

test("only handed-off sessions of reopenable types are recorded", () => {
  // The launch decides it, not the type: general-purpose runs automated or
  // handed off, and only the handed-off launch is a conversation to come back to.
  assert.equal(isLedgerRecordable(fleetSession({ agentId: "1", type: "general-purpose", sessionId: SESSIONS[0], startedAt: "2026-07-30T10:00:00.000Z" })), true);
  assert.equal(isLedgerRecordable(fleetSession({ agentId: "2", type: "general-purpose", sessionId: SESSIONS[1], startedAt: "2026-07-30T10:00:00.000Z", delivers: { mode: "tool-result" } })), false);
  assert.equal(isLedgerRecordable(fleetSession({ agentId: "3", type: "brainstormer", sessionId: SESSIONS[2], startedAt: "2026-07-30T10:00:00.000Z" })), true);
  // The Manager has its own resume; the automated-only research types have no
  // conversation to hand back, exactly as Restore Fleet already decides.
  assert.equal(isReopenableType("manager"), false);
  assert.equal(isReopenableType("webresearcher"), false);
  assert.equal(isReopenableType("Explore"), false);
  assert.equal(isReopenableType("pr-doctor-hitl"), true);
});

test("the ledger keeps one entry per agent, newest first, bounded by its limit", () => {
  let ledger: SessionLedgerDto | undefined;
  ledger = recordEndedSession(ledger, ended({ agentId: "7", endedAt: "2026-07-30T10:00:00.000Z" }));
  ledger = recordEndedSession(ledger, ended({ agentId: "8", endedAt: "2026-07-30T11:00:00.000Z" }));
  assert.deepEqual(ledger.sessions.map((entry) => entry.agentId), ["8", "7"]);

  // Reopened and ended again is the same conversation, so the later ending
  // replaces the earlier one rather than listing the agent twice.
  ledger = recordEndedSession(ledger, ended({ agentId: "7", endedAt: "2026-07-30T12:00:00.000Z", description: "second pass" }));
  assert.deepEqual(ledger.sessions.map((entry) => entry.agentId), ["7", "8"]);
  assert.equal(ledger.sessions.filter((entry) => entry.agentId === "7").length, 1);
  assert.equal(ledger.sessions[0]?.description, "second pass");

  const bounded = [1, 2, 3, 4].reduce<SessionLedgerDto | undefined>(
    (current, index) => recordEndedSession(current, ended({ agentId: `a${index}`, endedAt: `2026-07-30T1${index}:00:00.000Z` }), 2),
    undefined,
  );
  assert.deepEqual(bounded?.sessions.map((entry) => entry.agentId), ["a4", "a3"]);
  assert.equal(DEFAULT_SESSION_LEDGER_LIMIT > 0, true);
});

test("an ended record carries the launch facts a resume has to replay", () => {
  const record = endedSessionFrom(
    fleetSession({ agentId: "9", type: "general-purpose", sessionId: SESSIONS[1], startedAt: "2026-07-30T09:00:00.000Z", name: "aboard: general purpose interactive session", issueNumbers: [19, 20], chromeEnabled: true }),
    at("2026-07-30T10:30:00.000Z"),
  );
  // The prefix is aboard's own and is re-applied on reopen; storing it twice
  // would show "aboard: aboard: ..." in the picker.
  assert.equal(record.description, "general purpose interactive session");
  assert.deepEqual(record.issueNumbers, [19, 20]);
  assert.equal(record.chromeEnabled, true);
  assert.equal(record.endedAt, "2026-07-30T10:30:00.000Z");
});

test("candidates merge the fleet with the ledger, newest first, with the fleet winning a collision", () => {
  const ledger = recordEndedSession(
    recordEndedSession(undefined, ended({ agentId: "3", endedAt: "2026-07-30T08:00:00.000Z", sessionId: SESSIONS[2] })),
    ended({ agentId: "1", endedAt: "2026-07-30T12:00:00.000Z", sessionId: SESSIONS[0] }),
  );
  const candidates = reopenCandidates(
    ledger,
    [
      // Same agent as a ledger entry: it is running again, so the live record wins.
      fleetSession({ agentId: "1", type: "brainstormer", sessionId: SESSIONS[0], startedAt: "2026-07-30T13:00:00.000Z", terminalId: "open" }),
      fleetSession({ agentId: "2", type: "general-purpose", sessionId: SESSIONS[1], startedAt: "2026-07-30T11:00:00.000Z", terminalId: "closed" }),
      // Never offered: automated result-delivering launches and the Manager.
      fleetSession({ agentId: "4", type: "implementer", sessionId: SESSIONS[2], startedAt: "2026-07-30T14:00:00.000Z", delivers: { mode: "tool-result" } }),
      fleetSession({ agentId: "5", type: "manager", sessionId: SESSIONS[2], startedAt: "2026-07-30T15:00:00.000Z" }),
    ],
    (terminalId) => terminalId === "open",
  );
  assert.deepEqual(candidates.map((candidate) => [candidate.agentId, candidate.origin]), [
    ["1", "live"],
    ["2", "paused"],
    ["3", "ended"],
  ]);
  assert.equal(candidates[0]?.terminalId, "open");
  // A paused or ended candidate has no terminal to focus, so none is offered.
  assert.equal(candidates[1]?.terminalId, undefined);
});

test("a type this version will not reopen is ignored even when an older ledger holds it", () => {
  const ledger: SessionLedgerDto = {
    version: 1,
    sessions: [ended({ agentId: "6", type: "webresearcher", endedAt: "2026-07-30T10:00:00.000Z" })],
  };
  assert.deepEqual(reopenCandidates(ledger, [], () => false), []);
});

test("one unreadable ledger entry is dropped and the rest survive", () => {
  const parsed = parseSessionLedgerDto({
    version: 1,
    sessions: [
      { agentId: "7", type: "brainstormer", sessionId: SESSIONS[0], description: "spec", startedAt: "2026-07-30T09:00:00.000Z", endedAt: "2026-07-30T10:00:00.000Z" },
      { agentId: "8", type: "not-an-agent-type", sessionId: SESSIONS[1], description: "spec", startedAt: "2026-07-30T09:00:00.000Z", endedAt: "2026-07-30T10:00:00.000Z" },
      { agentId: "9", type: "general-purpose", sessionId: "not-a-uuid", description: "spec", startedAt: "2026-07-30T09:00:00.000Z", endedAt: "2026-07-30T10:00:00.000Z" },
    ],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.sessions.map((entry) => entry.agentId) : [], ["7"]);

  // A file that is not a ledger at all is a wrong file rather than a stale one.
  assert.equal(parseSessionLedgerDto({ version: 2, sessions: [] }).ok, false);
  assert.equal(parseSessionLedgerDto([]).ok, false);
});
