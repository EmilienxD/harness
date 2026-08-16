import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_TYPES,
  WORKER_FAILURE_TYPES,
  assertNever,
  type AgentLifecycle,
  type WorkerFailure,
} from "../src/domain/contracts.js";
import { parseAgentSession } from "../src/domain/validation.js";

const validSession = {
  identity: { agentId: "agent-1", type: "implementer" },
  sessionId: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee",
  terminal: { terminalId: "terminal-1", name: "aboard: implementer #2" },
  lifecycle: {
    status: "running",
    startedAt: "2026-07-29T10:00:00.000Z",
  },
  resultDelivery: { mode: "mailbox", managerAgentId: "manager-1" },
  telemetry: {
    totalTokens: 120,
    totalDurationMs: 2_000,
    totalToolUseCount: 3,
    compactionCount: 0,
    resolvedModel: "claude-opus",
  },
  issueNumber: 2,
} as const;

function describeLifecycle(lifecycle: AgentLifecycle): string {
  switch (lifecycle.status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "awaiting-user":
      return "awaiting user";
    case "completed":
      return `completed (${lifecycle.exitCode})`;
    case "failed":
      return describeFailure(lifecycle.failure);
    default:
      return assertNever(lifecycle);
  }
}

function describeFailure(failure: WorkerFailure): string {
  switch (failure.type) {
    case "crashed":
      return "crashed";
    case "context-exhausted":
      return "context exhausted";
    case "permission-denied":
      return "permission denied";
    case "no-commit":
      return "dirty tree";
    case "timeout":
      return "timed out";
    case "killed":
      return "cancelled by user";
    default:
      return assertNever(failure);
  }
}

test("parses a valid domain session from unknown input", () => {
  const result = parseAgentSession(validSession);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.identity.type, "implementer");
    assert.equal(describeLifecycle(result.value.lifecycle), "running");
  }
});

test("rejects unknown agent, lifecycle, result, and failure variants", () => {
  for (const [path, value] of [
    ["identity.type", "explorer"],
    ["lifecycle.status", "idle"],
    ["resultDelivery.mode", "callback"],
  ] as const) {
    const candidate = structuredClone(validSession) as unknown as Record<
      string,
      unknown
    >;
    const segments = path.split(".");
    const parent = candidate[segments[0]!] as Record<string, unknown>;
    parent[segments[1]!] = value;
    const result = parseAgentSession(candidate);
    assert.equal(result.ok, false);
  }

  const failed = structuredClone(validSession) as unknown as Record<
    string,
    unknown
  >;
  failed.lifecycle = {
    status: "failed",
    startedAt: "2026-07-29T10:00:00.000Z",
    finishedAt: "2026-07-29T10:01:00.000Z",
    failure: {
      type: "network-error",
      exitCode: 1,
      lastAssistantMessage: null,
    },
  };
  assert.equal(parseAgentSession(failed).ok, false);
});

test("enforces result and lifecycle invariants for agent roles", () => {
  const interactiveWithResult = structuredClone(validSession) as unknown as Record<
    string,
    unknown
  >;
  (interactiveWithResult.identity as Record<string, unknown>).type =
    "brainstormer";
  assert.equal(parseAgentSession(interactiveWithResult).ok, false);

  const automatedWithoutResult = structuredClone(validSession) as unknown as Record<
    string,
    unknown
  >;
  (automatedWithoutResult.resultDelivery as Record<string, unknown>).mode = "none";
  assert.equal(parseAgentSession(automatedWithoutResult).ok, false);

  const automatedAwaitingUser = structuredClone(validSession) as unknown as Record<
    string,
    unknown
  >;
  (automatedAwaitingUser.lifecycle as Record<string, unknown>).status =
    "awaiting-user";
  assert.equal(parseAgentSession(automatedAwaitingUser).ok, false);

  // Explore is automated-only, so it owes a result like any other worker.
  const exploreWithoutResult = structuredClone(validSession) as unknown as Record<
    string,
    unknown
  >;
  (exploreWithoutResult.identity as Record<string, unknown>).type = "Explore";
  (exploreWithoutResult.resultDelivery as Record<string, unknown>).mode = "none";
  assert.equal(parseAgentSession(exploreWithoutResult).ok, false);

  // general-purpose is neither automated nor interactive-only: handed to the
  // user it legally persists with no delivery, and rejecting it here would
  // discard the whole fleet snapshot on restore.
  const interactiveGeneralPurpose = structuredClone(validSession) as unknown as Record<
    string,
    unknown
  >;
  (interactiveGeneralPurpose.identity as Record<string, unknown>).type = "general-purpose";
  (interactiveGeneralPurpose.resultDelivery as Record<string, unknown>).mode = "none";
  delete (interactiveGeneralPurpose.resultDelivery as Record<string, unknown>).managerAgentId;
  assert.equal(parseAgentSession(interactiveGeneralPurpose).ok, true);
});

test("requires valid identifiers, timestamps, and telemetry", () => {
  const candidate = structuredClone(validSession) as unknown as Record<
    string,
    unknown
  >;
  candidate.sessionId = "not-a-uuid";
  (candidate.lifecycle as Record<string, unknown>).startedAt = "yesterday";
  (candidate.telemetry as Record<string, unknown>).totalTokens = -1;

  const result = parseAgentSession(candidate);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issues.length, 3);
  }
});

test("exhaustively handles every specified failure type", () => {
  const descriptions = WORKER_FAILURE_TYPES.map((type) =>
    describeFailure({ type, exitCode: null, lastAssistantMessage: null }),
  );
  assert.equal(descriptions.length, 6);
});

test("the legal agent catalogue ships no custom lowercase explorer type", () => {
  // `Explore` remains Claude Code's named builtin even though aboard now ships
  // launch metadata for it; a custom `explorer` stays excluded.
  assert.deepEqual(AGENT_TYPES, [
    "manager",
    "brainstormer",
    "webresearcher",
    "implementer",
    "pr-doctor-afk",
    "pr-doctor-hitl",
    "general-purpose",
    "Explore",
  ]);
  assert.equal((AGENT_TYPES as readonly string[]).includes("explorer"), false);
});
