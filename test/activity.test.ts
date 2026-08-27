import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_LIMIT,
  agentActivity,
  agentEntryId,
  appendActivity,
  describeActivity,
  hasReopenableEntries,
  isReopenableSession,
  isReopenableType,
  migrateLegacySessions,
  reopenCandidates,
  runActivity,
  shouldRecordEndedSession,
  type ActivityDto,
  type AgentOutcome,
  type LegacySessionRecord,
} from "../src/domain/activity.js";
import { parseActivityDto, parseLegacySessionLedger } from "../src/domain/validation.js";
import { clearActivityWarning, ActivityTreeModel } from "../src/vscode/activity.js";
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
  readonly sessionId?: string;
  readonly delivers?: boolean;
  readonly startedAt?: string;
  readonly issueNumbers?: readonly number[];
  readonly cwd?: string;
  readonly chromeEnabled?: true;
}): AgentSession {
  return {
    identity: { agentId: agent(overrides.agentId), type: overrides.type },
    sessionId: (overrides.sessionId ?? SESSIONS[0]) as SessionId,
    terminal: { terminalId: terminal(`terminal-${overrides.agentId}`), name: `aboard: ${overrides.type} conversation` },
    lifecycle: { status: "running", startedAt: at(overrides.startedAt ?? "2026-07-30T09:00:00.000Z") },
    resultDelivery: overrides.delivers === true ? { mode: "mcp", requestId: "r1" } : { mode: "none" },
    telemetry,
    ...(overrides.issueNumbers === undefined ? {} : { issueNumbers: overrides.issueNumbers }),
    ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
    ...(overrides.chromeEnabled === undefined ? {} : { chromeEnabled: overrides.chromeEnabled }),
  } as AgentSession;
}

test("reopenability follows the launch, not only the type", () => {
  // `general-purpose` runs both ways, and only the handed-off launch is a
  // conversation the user was part of.
  assert.equal(isReopenableSession(fleetSession({ agentId: "9", type: "general-purpose" })), true);
  assert.equal(isReopenableSession(fleetSession({ agentId: "9", type: "general-purpose", delivers: true })), false);
  // The Manager has its own resume path; a second one here would compete with it.
  assert.equal(isReopenableType("manager"), false);
  // Automated-only, with no caller left to receive a result.
  assert.equal(isReopenableType("webresearcher"), false);
  assert.equal(isReopenableType("Explore"), false);
  assert.equal(isReopenableType("brainstormer"), true);
});

test("an interactive launch is retained only after its conversation starts", () => {
  const interactive = fleetSession({ agentId: "9", type: "general-purpose" });
  assert.equal(shouldRecordEndedSession(interactive, false), false);
  assert.equal(shouldRecordEndedSession(interactive, true), true);

  // Automated outcomes remain useful history and do not depend on a resumable
  // user conversation.
  const automated = fleetSession({ agentId: "12", type: "general-purpose", delivers: true });
  assert.equal(shouldRecordEndedSession(automated, false), true);
});

test("an agent entry carries the launch facts a reopen replays, and nothing else", () => {
  const entry = agentActivity(
    fleetSession({ agentId: "11", type: "implementer", issueNumbers: [34], cwd: "C:/checkouts/run/repo", chromeEnabled: true }),
    "ended",
    at("2026-07-30T09:30:00.000Z"),
    { terminalId: terminal("terminal-11") },
  );
  assert.deepEqual(entry.reopen, {
    sessionId: SESSIONS[0] as SessionId,
    issueNumbers: [34],
    chromeEnabled: true,
    cwd: "C:/checkouts/run/repo",
  });
  assert.equal(entry.description, "implementer conversation");
  // Never a prompt, a transcript, an assistant message, a token, or an environment.
  assert.deepEqual(Object.keys(entry).filter((key) => /prompt|transcript|message|token|env/iu.test(key)), []);
});

test("an automated launch is recorded without a way back into it", () => {
  const entry = agentActivity(fleetSession({ agentId: "12", type: "webresearcher", delivers: true }), "succeeded", at("2026-07-30T09:30:00.000Z"));
  assert.equal(entry.reopen, undefined);
  assert.equal(entry.outcome, "succeeded");
});

test("appends are newest first, idempotent by id, and capped", () => {
  let store: ActivityDto | undefined;
  for (let index = 0; index < ACTIVITY_LIMIT + 5; index += 1) {
    store = appendActivity(store, runActivity({ runId: `run_${index}`, attempt: 1, outcome: "started", at: at("2026-07-30T09:00:00.000Z") }));
  }
  assert.equal(store?.entries.length, ACTIVITY_LIMIT);
  assert.equal(store?.entries[0]?.kind === "run" ? store.entries[0].runId : undefined, `run_${ACTIVITY_LIMIT + 4}`);

  // The terminal closing and the wrapper's marker vanishing observe the same
  // settlement milliseconds apart; that must be one row, not two.
  const session = fleetSession({ agentId: "7", type: "brainstormer" });
  let twice = appendActivity(undefined, agentActivity(session, "ended", at("2026-07-30T09:30:00.000Z")));
  twice = appendActivity(twice, agentActivity(session, "ended", at("2026-07-30T09:30:01.000Z")));
  assert.equal(twice.entries.length, 1);
  assert.equal(twice.entries[0]?.at, "2026-07-30T09:30:01.000Z");
});

test("a resumed run keeps its id, and start and outcome are separate rows per attempt", () => {
  let store = appendActivity(undefined, runActivity({ runId: "run_a", attempt: 1, outcome: "started", at: at("2026-07-30T09:00:00.000Z") }));
  store = appendActivity(store, runActivity({ runId: "run_a", attempt: 1, outcome: "interrupted", at: at("2026-07-30T09:10:00.000Z") }));
  store = appendActivity(store, runActivity({ runId: "run_a", attempt: 2, outcome: "resumed", at: at("2026-07-30T09:20:00.000Z") }));
  store = appendActivity(store, runActivity({ runId: "run_a", attempt: 2, outcome: "succeeded", at: at("2026-07-30T09:30:00.000Z") }));
  assert.equal(store.entries.length, 4);
  assert.equal(new Set(store.entries.map((entry) => entry.id)).size, 4);
});

test("outcomes read as roles rather than lifecycle names", () => {
  const session = fleetSession({ agentId: "7", type: "brainstormer" });
  const said = (outcome: AgentOutcome) => describeActivity(agentActivity(session, outcome, at("2026-07-30T09:30:00.000Z")));
  assert.equal(said("ended"), "brainstormer conversation ended");
  assert.equal(said("launch-failed"), "brainstormer could not start");
  assert.equal(said("interrupted"), "brainstormer interrupted");
  assert.equal(describeActivity(runActivity({ runId: "r", attempt: 1, outcome: "cancelled", at: at("2026-07-30T09:30:00.000Z") })), "auto-run stopped by you");
  assert.equal(describeActivity(runActivity({ runId: "r", attempt: 3, outcome: "resumed", at: at("2026-07-30T09:30:00.000Z") })), "auto-run resumed (attempt 3)");
});

test("migrating the old session ledger is idempotent and never displaces a newer outcome", () => {
  const legacy: LegacySessionRecord[] = [
    { agentId: agent("7"), type: "brainstormer", sessionId: SESSIONS[0] as SessionId, description: "spec", endedAt: at("2026-07-30T09:00:00.000Z") },
    { agentId: agent("9"), type: "general-purpose", sessionId: SESSIONS[1] as SessionId, description: "general", endedAt: at("2026-07-30T09:30:00.000Z") },
    // Never reopenable, so it has no business in the store.
    { agentId: agent("12"), type: "webresearcher", sessionId: SESSIONS[2] as SessionId, description: "research", endedAt: at("2026-07-30T09:40:00.000Z") },
  ];
  const once = migrateLegacySessions(undefined, legacy);
  assert.deepEqual(once.entries.map((entry) => entry.kind === "agent" ? entry.agentId : ""), [agent("9"), agent("7")]);
  assert.deepEqual(once, migrateLegacySessions(once, legacy));

  // This version knows the real outcome; the ledger only ever recorded "ended".
  const known = appendActivity(undefined, agentActivity(fleetSession({ agentId: "7", type: "brainstormer" }), "killed", at("2026-07-30T10:00:00.000Z")));
  const merged = migrateLegacySessions(known, legacy);
  assert.equal(merged.entries.filter((entry) => entry.kind === "agent" && entry.agentId === agent("7")).length, 1);
  assert.equal(merged.entries.find((entry) => entry.kind === "agent" && entry.agentId === agent("7"))?.id, agentEntryId(agent("7"), "killed"));
});

test("reopen candidates prefer the live fleet row and fall back to history", () => {
  const live = fleetSession({ agentId: "7", type: "brainstormer", startedAt: "2026-07-30T09:50:00.000Z" });
  const store = migrateLegacySessions(undefined, [
    { agentId: agent("7"), type: "brainstormer", sessionId: SESSIONS[2] as SessionId, description: "stale", endedAt: at("2026-07-30T08:00:00.000Z") },
    { agentId: agent("9"), type: "general-purpose", sessionId: SESSIONS[1] as SessionId, description: "general", endedAt: at("2026-07-30T09:00:00.000Z") },
  ]);
  const candidates = reopenCandidates(store, [live], () => true);
  assert.deepEqual(candidates.map((candidate) => candidate.agentId), [agent("7"), agent("9")]);
  assert.equal(candidates[0]?.origin, "live");
  assert.equal(candidates[0]?.sessionId, SESSIONS[0]);
  assert.equal(candidates[1]?.origin, "ended");
});

test("a fleet row whose terminal is gone reaches the list through history, not as live", () => {
  const orphan = fleetSession({ agentId: "7", type: "brainstormer" });
  const store = migrateLegacySessions(undefined, [
    { agentId: agent("7"), type: "brainstormer", sessionId: SESSIONS[2] as SessionId, description: "recorded", endedAt: at("2026-07-30T08:00:00.000Z") },
  ]);
  const candidates = reopenCandidates(store, [orphan], () => false);
  assert.deepEqual(candidates.map((candidate) => candidate.origin), ["ended"]);
});

test("Clear All warns only when it would cost a way back into a conversation", () => {
  assert.equal(clearActivityWarning(undefined), undefined);
  const automated = appendActivity(undefined, agentActivity(fleetSession({ agentId: "12", type: "webresearcher", delivers: true }), "succeeded", at("2026-07-30T09:00:00.000Z")));
  assert.equal(hasReopenableEntries(automated), false);
  assert.equal(clearActivityWarning(automated), undefined);

  const reopenable = appendActivity(automated, agentActivity(fleetSession({ agentId: "7", type: "brainstormer" }), "ended", at("2026-07-30T09:30:00.000Z")));
  assert.equal(hasReopenableEntries(reopenable), true);
  assert.match(clearActivityWarning(reopenable) ?? "", /1 conversation/);
  assert.match(clearActivityWarning(reopenable) ?? "", /transcripts themselves stay on disk/);
});

test("a malformed activity row is dropped without losing the file", () => {
  const good = agentActivity(fleetSession({ agentId: "7", type: "brainstormer" }), "ended", at("2026-07-30T09:30:00.000Z"));
  const parsed = parseActivityDto({
    version: 1,
    entries: [
      good,
      { kind: "agent", id: "agent:8:ended", at: "2026-07-30T09:00:00.000Z", agentId: "8", type: "nonsense", description: "x", outcome: "ended" },
      { kind: "run", id: "run:x:1:started", at: "nope", runId: "x", attempt: 1, outcome: "started" },
      // A duplicate id is the same row twice; the first one wins.
      good,
    ],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.entries.map((entry) => entry.id) : [], ["agent:7:ended"]);

  // A file that is not an activity store at all is a wrong file, not a stale one.
  for (const broken of [undefined, null, [], "activity", { version: 2, entries: [] }, { version: 1, entries: {} }]) {
    assert.equal(parseActivityDto(broken).ok, false, JSON.stringify(broken));
  }
});

test("a malformed reopen block costs the action, not the row", () => {
  const parsed = parseActivityDto({
    version: 1,
    entries: [{
      kind: "agent", id: "agent:7:ended", at: "2026-07-30T09:30:00.000Z",
      agentId: "7", type: "brainstormer", description: "spec", outcome: "ended",
      reopen: { sessionId: "not-a-uuid" },
    }],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.entries[0]?.kind === "agent" && parsed.value.entries[0].reopen : undefined, undefined);
});

test("the legacy ledger parser drops unreadable entries rather than the file", () => {
  const parsed = parseLegacySessionLedger({
    version: 1,
    sessions: [
      { agentId: "7", type: "brainstormer", sessionId: SESSIONS[0], description: "spec", endedAt: "2026-07-30T09:30:00.000Z" },
      { agentId: "8", type: "brainstormer", sessionId: "nope", description: "spec", endedAt: "2026-07-30T09:30:00.000Z" },
    ],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.sessions.map((entry) => entry.agentId) : [], [agent("7")]);
});

test("a row offers only the actions it can actually perform", () => {
  const openTerminals = new Set<string>(["terminal-7"]);
  const entries = [
    agentActivity(fleetSession({ agentId: "7", type: "brainstormer", issueNumbers: [34] }), "ended", at("2026-07-30T09:30:00.000Z"), { terminalId: terminal("terminal-7") }),
    agentActivity(fleetSession({ agentId: "9", type: "general-purpose" }), "ended", at("2026-07-30T09:00:00.000Z"), { terminalId: terminal("terminal-9") }),
    runActivity({ runId: "run_a", attempt: 1, outcome: "succeeded", at: at("2026-07-30T08:00:00.000Z"), issueNumbers: [34, 35], pullRequest: 60 }),
    agentActivity(fleetSession({ agentId: "1", type: "manager" }), "interrupted", at("2026-07-30T07:00:00.000Z")),
  ];
  const model = new ActivityTreeModel({ entries: () => entries, isTerminalOpen: (id) => openTerminals.has(id) });
  const items = model.roots().map((node) => model.item(node));

  // Terminal still open: focus it, and do not offer to relaunch the same session.
  assert.match(items[0]?.contextValue ?? "", /terminal/);
  assert.doesNotMatch(items[0]?.contextValue ?? "", /reopen/);
  assert.equal(items[0]?.command?.command, "aboard.activity.openTerminal");
  // Terminal gone, conversation intact: reopening is the way back.
  assert.match(items[1]?.contextValue ?? "", /reopen/);
  assert.equal(items[1]?.command?.command, "aboard.activity.reopen");
  // A run row names its issues and its pull request.
  assert.match(items[2]?.contextValue ?? "", /issue/);
  assert.match(items[2]?.contextValue ?? "", /pr/);
  assert.equal(items[2]?.label, "auto-run finished");
  // Manager continuity has its own command rather than the generic session reopen path.
  assert.match(items[3]?.contextValue ?? "", /manager/);
  assert.equal(items[3]?.command?.command, "aboard.resumeManager");
});
