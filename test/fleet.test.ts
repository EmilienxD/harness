import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentId,
  AgentSession,
  IsoTimestamp,
  SessionId,
  WorkerResult,
} from "../src/domain/contracts.js";
import {
  FleetRegistry,
  FleetStateError,
} from "../src/domain/fleet.js";
import {
  parseFleetPersistenceDto,
  parseManagerPersistenceDto,
} from "../src/domain/validation.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const startedAt = at("2026-07-29T10:00:00.000Z");
const finishedAt = at("2026-07-29T10:05:00.000Z");
const telemetry = {
  totalTokens: 100,
  totalDurationMs: 1_000,
  totalToolUseCount: 2,
  compactionCount: 0,
};

function createSession(
  agentId: string,
  sessionId: string,
  delivery: AgentSession["resultDelivery"],
  type: AgentSession["identity"]["type"] = "implementer",
): AgentSession {
  return {
    identity: { agentId: agent(agentId), type },
    sessionId: session(sessionId),
    terminal: { terminalId: `terminal-${agentId}` as AgentSession["terminal"]["terminalId"], name: agentId },
    lifecycle: { status: "starting", startedAt },
    resultDelivery: delivery,
    telemetry,
  };
}

const success: WorkerResult = {
  outcome: "succeeded",
  exitCode: 0,
  lastAssistantMessage: "done",
  telemetry,
};

test("registers only imposed unique agent and session identities", () => {
  const fleet = new FleetRegistry();
  fleet.register(
    createSession("worker-1", "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", { mode: "tool-result" }),
    startedAt,
  );
  assert.equal(
    fleet.getBySession(session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"))?.identity.agentId,
    "worker-1",
  );
  assert.throws(
    () => fleet.register(
      createSession("worker-1", "af817a6c-cd41-41e2-a4db-44d3f43cd560", { mode: "tool-result" }),
      startedAt,
    ),
    (error) => error instanceof FleetStateError && error.code === "duplicate-agent",
  );
  assert.throws(
    () => fleet.transition(agent("hand-started"), { status: "running", startedAt }, startedAt),
    (error) => error instanceof FleetStateError && error.code === "unknown-agent",
  );
});

test("rejects impossible lifecycle moves and records timestamped history", () => {
  const fleet = new FleetRegistry();
  fleet.register(
    createSession("worker-1", "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", { mode: "tool-result" }),
    startedAt,
  );
  assert.throws(
    () => fleet.transition(agent("worker-1"), { status: "awaiting-user", startedAt }, startedAt),
    (error) => error instanceof FleetStateError && error.code === "invalid-transition",
  );
  fleet.transition(agent("worker-1"), { status: "running", startedAt }, startedAt);
  fleet.transition(
    agent("worker-1"),
    { status: "completed", startedAt, finishedAt, exitCode: 0, lastAssistantMessage: "done" },
    finishedAt,
  );
  assert.deepEqual(fleet.events().map((event) => event.sequence), [1, 2, 3]);
  assert.equal(fleet.events()[2]?.occurredAt, finishedAt);
});

test("delivers blocking and background results exactly once", () => {
  const fleet = new FleetRegistry();
  const managerId = agent("manager-1");
  fleet.register(
    createSession("manager-1", "140b5c21-eb37-4147-b5cb-6a5ca2592146", { mode: "none" }, "manager"),
    startedAt,
  );
  fleet.register(
    createSession("blocking", "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", { mode: "tool-result" }),
    startedAt,
  );
  fleet.register(
    createSession("background", "af817a6c-cd41-41e2-a4db-44d3f43cd560", { mode: "mailbox", managerAgentId: managerId }),
    startedAt,
  );
  for (const id of ["blocking", "background"]) {
    fleet.transition(agent(id), { status: "running", startedAt }, startedAt);
    fleet.transition(
      agent(id),
      { status: "completed", startedAt, finishedAt, exitCode: 0, lastAssistantMessage: "done" },
      finishedAt,
    );
    fleet.recordResult(agent(id), success, finishedAt);
  }
  assert.equal(fleet.takeBlockingResult(agent("blocking"), finishedAt)?.outcome, "succeeded");
  assert.equal(fleet.takeBlockingResult(agent("blocking"), finishedAt), undefined);
  assert.deepEqual(fleet.drainMailbox(managerId, finishedAt).map((entry) => entry.agentId), ["background"]);
  assert.deepEqual(fleet.drainMailbox(managerId, finishedAt), []);
});

test("drains deferred notifications in order with an explicit large-queue summary", () => {
  const fleet = new FleetRegistry();
  const managerId = agent("manager-1");
  fleet.register(
    createSession("manager-1", "140b5c21-eb37-4147-b5cb-6a5ca2592146", { mode: "none" }, "manager"),
    startedAt,
  );
  for (let index = 0; index < 5; index += 1) {
    fleet.enqueueNotification(managerId, `event ${index}`, at(`2026-07-29T10:0${index}:00.000Z`));
  }
  const delivery = fleet.drainNotifications(managerId, finishedAt, { maxDetailedEntries: 2 });
  assert.deepEqual(delivery.notifications.map((entry) => entry.message), ["event 3", "event 4"]);
  assert.deepEqual(delivery.summarized, {
    count: 3,
    firstOccurredAt: "2026-07-29T10:00:00.000Z",
    lastOccurredAt: "2026-07-29T10:02:00.000Z",
  });
  assert.deepEqual(fleet.drainNotifications(managerId, finishedAt), { notifications: [] });
});

test("round-trips fleet persistence through unknown boundary validation", () => {
  const fleet = new FleetRegistry();
  fleet.register(
    createSession("worker-1", "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", { mode: "tool-result" }),
    startedAt,
  );
  const serialized: unknown = JSON.parse(JSON.stringify(fleet.toPersistenceDto()));
  const parsed = parseFleetPersistenceDto(serialized);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const restored = FleetRegistry.restore(parsed.value);
  assert.deepEqual(restored.toPersistenceDto(), fleet.toPersistenceDto());
});

test("validates the separately persisted long-lived Manager identity", () => {
  const parsed = parseManagerPersistenceDto({
    version: 1,
    agentId: "manager-1",
    sessionId: "140b5c21-eb37-4147-b5cb-6a5ca2592146",
    terminalId: "terminal-manager-1",
    updatedAt: "2026-07-29T10:00:00.000Z",
  });
  assert.equal(parsed.ok, true);
  assert.equal(
    parseManagerPersistenceDto({ version: 1, sessionId: "hand-started" }).ok,
    false,
  );
});

test("restart relaunches a finished agent and rebinds session routing when the conversation is new", () => {
  const fleet = new FleetRegistry();
  const managerId = agent("manager-1");
  fleet.register(createSession("manager-1", "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", { mode: "none" }, "manager"), startedAt);
  fleet.transition(managerId, { status: "running", startedAt }, startedAt);
  assert.throws(
    () => fleet.restart(managerId, { terminalId: "t2" as AgentSession["terminal"]["terminalId"], name: "aboard: Manager" }, finishedAt),
    (error) => error instanceof FleetStateError && error.code === "invalid-transition",
  );

  fleet.transition(managerId, { status: "completed", startedAt, finishedAt, exitCode: 0, lastAssistantMessage: null }, finishedAt);
  // Resume keeps the recorded session; a new conversation replaces it and the
  // old session id must stop resolving.
  fleet.restart(managerId, { terminalId: "t2" as AgentSession["terminal"]["terminalId"], name: "aboard: Manager" }, finishedAt);
  assert.equal(fleet.get(managerId)?.sessionId, "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee");
  fleet.transition(managerId, { status: "completed", startedAt: finishedAt, finishedAt, exitCode: 0, lastAssistantMessage: null }, finishedAt);
  fleet.restart(managerId, { terminalId: "t3" as AgentSession["terminal"]["terminalId"], name: "aboard: Manager" }, finishedAt, session("af817a6c-cd41-41e2-a4db-44d3f43cd560"));
  assert.equal(fleet.get(managerId)?.sessionId, "af817a6c-cd41-41e2-a4db-44d3f43cd560");
  assert.equal(fleet.getBySession(session("af817a6c-cd41-41e2-a4db-44d3f43cd560"))?.identity.agentId, "manager-1");
  assert.equal(fleet.getBySession(session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee")), undefined);
});

test("reattach preserves active identity, replaces the terminal, and hands restored workers to the user", () => {
  const fleet = new FleetRegistry();
  const workerId = agent("worker-1");
  fleet.register(createSession("worker-1", "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", { mode: "tool-result" }), startedAt);
  fleet.transition(workerId, { status: "running", startedAt }, startedAt);
  fleet.reattach(
    workerId,
    { terminalId: "restored-terminal" as AgentSession["terminal"]["terminalId"], name: "worker-1" },
    finishedAt,
    undefined,
    { mode: "none" },
  );
  assert.equal(fleet.get(workerId)?.terminal.terminalId, "restored-terminal");
  assert.equal(fleet.get(workerId)?.lifecycle.status, "starting");
  assert.deepEqual(fleet.get(workerId)?.resultDelivery, { mode: "none" });
});

test("removing an agent forgets its session, children, and undelivered results", () => {
  const fleet = new FleetRegistry();
  const managerId = agent("manager-1");
  const workerId = agent("worker-1");
  fleet.register(createSession("manager-1", "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", { mode: "none" }, "manager"), startedAt);
  fleet.register(createSession("worker-1", "af817a6c-cd41-41e2-a4db-44d3f43cd560", { mode: "mailbox", managerAgentId: managerId }), startedAt);
  fleet.startChild({ agentId: "child-1", parentAgentId: workerId, type: "Explore", status: "running", startedAt, telemetry }, startedAt);
  fleet.transition(workerId, { status: "completed", startedAt, finishedAt, exitCode: 0, lastAssistantMessage: "done" }, finishedAt);
  fleet.recordResult(workerId, { outcome: "succeeded", exitCode: 0, lastAssistantMessage: "done", telemetry }, finishedAt);

  const events: string[] = [];
  fleet.onDidChange((event) => events.push(event.type));
  fleet.remove(workerId, finishedAt);
  assert.equal(fleet.get(workerId), undefined);
  assert.equal(fleet.getBySession(session("af817a6c-cd41-41e2-a4db-44d3f43cd560")), undefined);
  assert.deepEqual(fleet.listChildren(workerId), []);
  assert.deepEqual(fleet.drainMailbox(managerId, finishedAt), []);
  assert.deepEqual(events, ["agent-removed"]);
  fleet.remove(workerId, finishedAt);
  assert.deepEqual(events, ["agent-removed"], "removing an absent agent is a no-op");

  fleet.clear(finishedAt);
  assert.deepEqual(fleet.list(), []);
  assert.deepEqual(fleet.listChildren(), []);
  assert.deepEqual(parseFleetPersistenceDto(JSON.parse(JSON.stringify(fleet.toPersistenceDto())) as unknown).ok, true);
});
