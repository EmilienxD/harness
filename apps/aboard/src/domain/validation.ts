import {
  AGENT_TYPES,
  AGENT_PLATFORM_IDS,
  INTERACTIVE_AGENT_TYPES,
  WORKER_FAILURE_TYPES,
  isAutomatedAgentType,
  isAutoRunWorkerType,
  type AgentId,
  type AgentPlatformId,
  type AgentIdentity,
  type AgentLifecycle,
  type AgentSession,
  type AgentTelemetry,
  type AgentType,
  type IsoTimestamp,

  type ResultDelivery,
  type SessionId,
  type TerminalId,
  type TerminalReference,
  type WorkerFailure,
  type WorkerResult,
} from "./contracts.js";
import type { FleetEvent, FleetPersistenceDto } from "./fleet.js";
import type {
  ActivityDto,
  ActivityEntry,
  AgentOutcome,
  ReopenableSession,
  RunOutcome,
} from "./activity.js";


const AGENT_OUTCOMES: readonly AgentOutcome[] = [
  "succeeded", "failed", "cancelled", "ended", "killed", "launch-failed", "interrupted",
];
const RUN_OUTCOMES: readonly RunOutcome[] = [
  "started", "resumed", "succeeded", "cancelled", "interrupted", "failed", "discarded",
];

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INTERACTIVE_TYPES: ReadonlySet<AgentType> = new Set(INTERACTIVE_AGENT_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(
  value: unknown,
  path: string,
  issues: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  return value;
}

function readNonEmptyString(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function readNonNegativeInteger(
  value: unknown,
  path: string,
  issues: string[],
): number | undefined {
  if (!Number.isInteger(value) || (value as number) < 0) {
    issues.push(`${path} must be a non-negative integer`);
    return undefined;
  }
  return value as number;
}

function readExitCode(
  value: unknown,
  path: string,
  issues: string[],
): number | undefined {
  if (!Number.isInteger(value)) {
    issues.push(`${path} must be an integer`);
    return undefined;
  }
  return value as number;
}

function readNullableString(
  value: unknown,
  path: string,
  issues: string[],
): string | null | undefined {
  if (value === null || typeof value === "string") {
    return value;
  }
  issues.push(`${path} must be a string or null`);
  return undefined;
}

function readTimestamp(
  value: unknown,
  path: string,
  issues: string[],
): IsoTimestamp | undefined {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    !value.includes("T")
  ) {
    issues.push(`${path} must be an ISO-8601 timestamp`);
    return undefined;
  }
  return value as IsoTimestamp;
}

function parseAgentType(
  value: unknown,
  path: string,
  issues: string[],
): AgentType | undefined {
  if (typeof value === "string" && AGENT_TYPES.includes(value as AgentType)) {
    return value as AgentType;
  }
  issues.push(`${path} must be one of: ${AGENT_TYPES.join(", ")}`);
  return undefined;
}

function parseAgentPlatform(value: unknown, path: string, issues: string[]): AgentPlatformId | undefined {
  if (typeof value === "string" && (AGENT_PLATFORM_IDS as readonly string[]).includes(value)) return value as AgentPlatformId;
  issues.push(`${path} must be one of: ${AGENT_PLATFORM_IDS.join(", ")}`);
  return undefined;
}

function parseIdentity(
  value: unknown,
  path: string,
  issues: string[],
): AgentIdentity | undefined {
  const record = readRecord(value, path, issues);
  if (record === undefined) return undefined;

  const agentId = readNonEmptyString(record.agentId, `${path}.agentId`, issues);
  const type = parseAgentType(record.type, `${path}.type`, issues);
  if (agentId === undefined || type === undefined) return undefined;
  return { agentId: agentId as AgentId, type };
}

function parseSessionId(
  value: unknown,
  path: string,
  issues: string[],
): SessionId | undefined {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    issues.push(`${path} must be a UUID`);
    return undefined;
  }
  return value as SessionId;
}

function parseTerminal(
  value: unknown,
  path: string,
  issues: string[],
): TerminalReference | undefined {
  const record = readRecord(value, path, issues);
  if (record === undefined) return undefined;
  const terminalId = readNonEmptyString(
    record.terminalId,
    `${path}.terminalId`,
    issues,
  );
  const name = readNonEmptyString(record.name, `${path}.name`, issues);
  if (terminalId === undefined || name === undefined) return undefined;
  return { terminalId: terminalId as TerminalId, name };
}

function parseTelemetry(
  value: unknown,
  path: string,
  issues: string[],
): AgentTelemetry | undefined {
  const record = readRecord(value, path, issues);
  if (record === undefined) return undefined;

  const totalTokens = readNonNegativeInteger(
    record.totalTokens,
    `${path}.totalTokens`,
    issues,
  );
  const totalDurationMs = readNonNegativeInteger(
    record.totalDurationMs,
    `${path}.totalDurationMs`,
    issues,
  );
  const totalToolUseCount = readNonNegativeInteger(
    record.totalToolUseCount,
    `${path}.totalToolUseCount`,
    issues,
  );
  const compactionCount = readNonNegativeInteger(
    record.compactionCount,
    `${path}.compactionCount`,
    issues,
  );
  const resolvedModel =
    record.resolvedModel === undefined
      ? undefined
      : readNonEmptyString(record.resolvedModel, `${path}.resolvedModel`, issues);
  const usageRecord = record.usage === undefined ? undefined : readRecord(record.usage, `${path}.usage`, issues);
  const inputTokens = usageRecord?.inputTokens === undefined ? undefined : readNonNegativeInteger(usageRecord.inputTokens, `${path}.usage.inputTokens`, issues);
  const outputTokens = usageRecord?.outputTokens === undefined ? undefined : readNonNegativeInteger(usageRecord.outputTokens, `${path}.usage.outputTokens`, issues);
  const cacheCreationInputTokens = usageRecord?.cacheCreationInputTokens === undefined ? undefined : readNonNegativeInteger(usageRecord.cacheCreationInputTokens, `${path}.usage.cacheCreationInputTokens`, issues);
  const cacheReadInputTokens = usageRecord?.cacheReadInputTokens === undefined ? undefined : readNonNegativeInteger(usageRecord.cacheReadInputTokens, `${path}.usage.cacheReadInputTokens`, issues);
  const usage = usageRecord === undefined ? undefined : { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }), ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }) };

  if (
    totalTokens === undefined ||
    totalDurationMs === undefined ||
    totalToolUseCount === undefined ||
    compactionCount === undefined ||
    (record.resolvedModel !== undefined && resolvedModel === undefined)
  ) {
    return undefined;
  }

  const base = {
        totalTokens,
        totalDurationMs,
        totalToolUseCount,
        compactionCount,
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
        ...(usage === undefined ? {} : { usage }),
      };
  return base;
}

function parseFailure(
  value: unknown,
  path: string,
  issues: string[],
): WorkerFailure | undefined {
  const record = readRecord(value, path, issues);
  if (record === undefined) return undefined;
  if (
    typeof record.type !== "string" ||
    !WORKER_FAILURE_TYPES.includes(
      record.type as (typeof WORKER_FAILURE_TYPES)[number],
    )
  ) {
    issues.push(`${path}.type must be one of: ${WORKER_FAILURE_TYPES.join(", ")}`);
    return undefined;
  }

  const exitCode =
    record.exitCode === null
      ? null
      : readExitCode(record.exitCode, `${path}.exitCode`, issues);
  const lastAssistantMessage = readNullableString(
    record.lastAssistantMessage,
    `${path}.lastAssistantMessage`,
    issues,
  );
  if (exitCode === undefined || lastAssistantMessage === undefined) {
    return undefined;
  }
  return { type: record.type, exitCode, lastAssistantMessage } as WorkerFailure;
}

function parseLifecycle(
  value: unknown,
  path: string,
  issues: string[],
): AgentLifecycle | undefined {
  const record = readRecord(value, path, issues);
  if (record === undefined) return undefined;
  const startedAt = readTimestamp(record.startedAt, `${path}.startedAt`, issues);
  if (startedAt === undefined) return undefined;

  switch (record.status) {
    case "starting":
    case "running":
    case "awaiting-user":
      return { status: record.status, startedAt };
    case "completed": {
      const finishedAt = readTimestamp(
        record.finishedAt,
        `${path}.finishedAt`,
        issues,
      );
      const exitCode = readExitCode(record.exitCode, `${path}.exitCode`, issues);
      const lastAssistantMessage = readNullableString(
        record.lastAssistantMessage,
        `${path}.lastAssistantMessage`,
        issues,
      );
      if (
        finishedAt === undefined ||
        exitCode === undefined ||
        lastAssistantMessage === undefined
      ) {
        return undefined;
      }
      return {
        status: "completed",
        startedAt,
        finishedAt,
        exitCode,
        lastAssistantMessage,
      };
    }
    case "failed": {
      const finishedAt = readTimestamp(
        record.finishedAt,
        `${path}.finishedAt`,
        issues,
      );
      const failure = parseFailure(record.failure, `${path}.failure`, issues);
      if (finishedAt === undefined || failure === undefined) return undefined;
      return { status: "failed", startedAt, finishedAt, failure };
    }
    default:
      issues.push(
        `${path}.status must be one of: starting, running, awaiting-user, completed, failed`,
      );
      return undefined;
  }
}

function parseResultDelivery(
  value: unknown,
  path: string,
  issues: string[],
): ResultDelivery | undefined {
  const record = readRecord(value, path, issues);
  if (record === undefined) return undefined;
  switch (record.mode) {
    case "tool-result":
    case "none":
      return { mode: record.mode };

    default:
      issues.push(`${path}.mode must be one of: tool-result, none`);
      return undefined;
  }
}

function parseWorkerResult(
  value: unknown,
  path: string,
  issues: string[],
): WorkerResult | undefined {
  const record = readRecord(value, path, issues);
  if (record === undefined) return undefined;
  const telemetry = parseTelemetry(record.telemetry, `${path}.telemetry`, issues);
  if (record.outcome === "succeeded") {
    const exitCode = readExitCode(record.exitCode, `${path}.exitCode`, issues);
    const lastAssistantMessage = readNonEmptyString(
      record.lastAssistantMessage,
      `${path}.lastAssistantMessage`,
      issues,
    );
    return telemetry === undefined || exitCode === undefined || lastAssistantMessage === undefined
      ? undefined
      : { outcome: "succeeded", exitCode, lastAssistantMessage, telemetry };
  }
  if (record.outcome === "failed") {
    const failure = parseFailure(record.failure, `${path}.failure`, issues);
    return telemetry === undefined || failure === undefined
      ? undefined
      : { outcome: "failed", failure, telemetry };
  }
  issues.push(`${path}.outcome must be one of: succeeded, failed`);
  return undefined;
}

export function parseAgentSession(value: unknown): ValidationResult<AgentSession> {
  const issues: string[] = [];
  const record = readRecord(value, "session", issues);
  if (record === undefined) return { ok: false, issues };

  const identity = parseIdentity(record.identity, "session.identity", issues);
  const platform = parseAgentPlatform(record.platform, "session.platform", issues);
  const sessionId = parseSessionId(record.sessionId, "session.sessionId", issues);
  const sessionBinding = record.sessionBinding === "provisional" || record.sessionBinding === "bound"
    ? record.sessionBinding
    : (issues.push("session.sessionBinding must be provisional or bound"), undefined);
  const terminal = parseTerminal(record.terminal, "session.terminal", issues);
  const title = record.title === undefined ? undefined : readNonEmptyString(record.title, "session.title", issues);
  const lifecycle = parseLifecycle(record.lifecycle, "session.lifecycle", issues);
  const resultDelivery = parseResultDelivery(
    record.resultDelivery,
    "session.resultDelivery",
    issues,
  );
  const executionMode = record.executionMode === undefined ? undefined
    : record.executionMode === "interactive" || record.executionMode === "auto" || record.executionMode === "auto-run" || record.executionMode === "loop"
      ? record.executionMode
      : (issues.push("session.executionMode must be interactive, auto, auto-run, or loop"), undefined);
  const telemetry = parseTelemetry(record.telemetry, "session.telemetry", issues);
  let chromeEnabled: true | undefined;
  if (record.chromeEnabled !== undefined) {
    if (record.chromeEnabled === true) chromeEnabled = true;
    else issues.push("session.chromeEnabled must be true when present");
  }
  const issueNumbers = record.issueNumbers === undefined ? undefined : Array.isArray(record.issueNumbers)
    ? record.issueNumbers.map((value, index) => readNonNegativeInteger(value, `session.issueNumbers[${index}]`, issues))
    : (issues.push("session.issueNumbers must be an array"), undefined);
  const lastResult =
    record.lastResult === undefined
      ? undefined
      : parseWorkerResult(record.lastResult, "session.lastResult", issues);
  let cwd: string | undefined;
  if (record.cwd !== undefined) {
    if (typeof record.cwd === "string" && record.cwd.trim().length > 0) cwd = record.cwd;
    else issues.push("session.cwd must be a non-empty string when present");
  }
  let autoRunRestricted: true | undefined;
  if (record.autoRunRestricted !== undefined) {
    if (record.autoRunRestricted === true) autoRunRestricted = true;
    else issues.push("session.autoRunRestricted must be true when present");
  }
  let attended: true | undefined;
  if (record.attended !== undefined) {
    if (record.attended === true) attended = true;
    else issues.push("session.attended must be true when present");
  }
  let lastObservedAssistantMessage: string | undefined;
  if (record.lastObservedAssistantMessage !== undefined) {
    if (typeof record.lastObservedAssistantMessage === "string" && record.lastObservedAssistantMessage.trim().length > 0) {
      lastObservedAssistantMessage = record.lastObservedAssistantMessage;
    } else issues.push("session.lastObservedAssistantMessage must be a non-empty string when present");
  }
  const compactSummaries = record.compactSummaries === undefined ? undefined : Array.isArray(record.compactSummaries)
    ? record.compactSummaries.map((value, index) => readNonEmptyString(value, `session.compactSummaries[${index}]`, issues))
    : (issues.push("session.compactSummaries must be an array"), undefined);

  if (identity !== undefined && resultDelivery !== undefined) {
    if (chromeEnabled === true && !isAutoRunWorkerType(identity.type)) {
      issues.push("session.chromeEnabled is only legal for auto-run worker agents");
    }
    if (
      isAutomatedAgentType(identity.type) && executionMode !== "auto" &&
      resultDelivery.mode === "none"
    ) {
      issues.push(
        `session.resultDelivery.mode must deliver a result for ${identity.type} agents`,
      );
    }
    if (
      lifecycle?.status === "awaiting-user" &&
      !INTERACTIVE_TYPES.has(identity.type) && executionMode !== "interactive"
    ) {
      issues.push(
        `session.lifecycle.status awaiting-user is only legal for interactive agents`,
      );
    }
  }

  if (
    issues.length > 0 ||
    identity === undefined ||
    platform === undefined ||
    sessionId === undefined ||
    sessionBinding === undefined ||
    terminal === undefined ||
    lifecycle === undefined ||
    resultDelivery === undefined ||
    telemetry === undefined ||
    (record.issueNumbers !== undefined && issueNumbers === undefined)
    || issueNumbers?.some((value) => value === undefined)
    || (record.lastResult !== undefined && lastResult === undefined)
    || compactSummaries?.some((value) => value === undefined)
  ) {
    return { ok: false, issues };
  }

  const base: AgentSession = {
    platform,
    identity,
    sessionId,
    sessionBinding,
    terminal,
    ...(title === undefined ? {} : { title }),
    lifecycle,
    resultDelivery,
    ...(executionMode === undefined ? {} : { executionMode }),
    ...(attended === undefined ? {} : { attended }),
    telemetry,
    ...(chromeEnabled === undefined ? {} : { chromeEnabled }),
    ...(lastResult === undefined ? {} : { lastResult }),
    // An empty array carries no attribution, so it round trips as absence
    // rather than as a session bound to nothing.
    ...(issueNumbers === undefined || issueNumbers.length === 0 ? {} : { issueNumbers: issueNumbers as number[] }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(autoRunRestricted === undefined ? {} : { autoRunRestricted }),
    ...(compactSummaries === undefined ? {} : { compactSummaries: compactSummaries as string[] }),
    ...(lastObservedAssistantMessage === undefined ? {} : { lastObservedAssistantMessage }),
  };
  return { ok: true, value: base };
}

export function parseFleetPersistenceDto(
  value: unknown,
): ValidationResult<FleetPersistenceDto> {
  const issues: string[] = [];
  const record = readRecord(value, "fleet", issues);
  if (record === undefined) return { ok: false, issues };
  if (record.version !== 1) issues.push("fleet.version must be 1");

  const parseArray = <T>(
    candidate: unknown,
    path: string,
    parse: (item: unknown, path: string, issues: string[]) => T | undefined,
  ): T[] | undefined => {
    if (!Array.isArray(candidate)) {
      issues.push(`${path} must be an array`);
      return undefined;
    }
    const parsed = candidate.map((item, index) => parse(item, `${path}[${index}]`, issues));
    return parsed.some((item) => item === undefined) ? undefined : (parsed as T[]);
  };

  const sessions = parseArray(record.sessions, "fleet.sessions", (item, path, innerIssues) => {
    const parsed = parseAgentSession(item);
    if (!parsed.ok) {
      innerIssues.push(...parsed.issues.map((issue) => `${path}: ${issue}`));
      return undefined;
    }
    return parsed.value;
  });

  const parseResultEntry = (
    item: unknown,
    path: string,
    innerIssues: string[],
  ): { readonly agentId: AgentId; readonly result: WorkerResult } | undefined => {
    const entry = readRecord(item, path, innerIssues);
    if (entry === undefined) return undefined;
    const agentId = readNonEmptyString(entry.agentId, `${path}.agentId`, innerIssues);
    const result = parseWorkerResult(entry.result, `${path}.result`, innerIssues);
    return agentId === undefined || result === undefined
      ? undefined
      : { agentId: agentId as AgentId, result };
  };
  const blockingResults = parseArray(
    record.blockingResults,
    "fleet.blockingResults",
    parseResultEntry,
  );


  const events = parseArray<FleetEvent>(record.events, "fleet.events", (item, path, innerIssues) => {
    const event = readRecord(item, path, innerIssues);
    if (event === undefined) return undefined;
    const sequence = readNonNegativeInteger(event.sequence, `${path}.sequence`, innerIssues);
    const occurredAt = readTimestamp(event.occurredAt, `${path}.occurredAt`, innerIssues);
    if (sequence === undefined || occurredAt === undefined) return undefined;
    switch (event.type) {
      case "agent-registered": {
        const agentId = readNonEmptyString(event.agentId, `${path}.agentId`, innerIssues);
        const sessionId = parseSessionId(event.sessionId, `${path}.sessionId`, innerIssues);
        return agentId === undefined || sessionId === undefined
          ? undefined
          : { sequence, occurredAt, type: "agent-registered", agentId: agentId as AgentId, sessionId };
      }
      case "agent-removed": {
        const agentId = readNonEmptyString(event.agentId, `${path}.agentId`, innerIssues);
        const sessionId = parseSessionId(event.sessionId, `${path}.sessionId`, innerIssues);
        return agentId === undefined || sessionId === undefined
          ? undefined
          : { sequence, occurredAt, type: "agent-removed", agentId: agentId as AgentId, sessionId };
      }
      case "session-bound": {
        const agentId = readNonEmptyString(event.agentId, `${path}.agentId`, innerIssues);
        const from = parseSessionId(event.from, `${path}.from`, innerIssues);
        const to = parseSessionId(event.to, `${path}.to`, innerIssues);
        return agentId === undefined || from === undefined || to === undefined
          ? undefined
          : { sequence, occurredAt, type: event.type, agentId: agentId as AgentId, from, to };
      }
      case "lifecycle-transitioned": {
        const agentId = readNonEmptyString(event.agentId, `${path}.agentId`, innerIssues);
        const statuses = ["starting", "running", "awaiting-user", "completed", "failed"] as const;
        const from = statuses.find((status) => status === event.from);
        const to = statuses.find((status) => status === event.to);
        if (from === undefined) innerIssues.push(`${path}.from must be a lifecycle status`);
        if (to === undefined) innerIssues.push(`${path}.to must be a lifecycle status`);
        return agentId === undefined || from === undefined || to === undefined
          ? undefined
          : { sequence, occurredAt, type: event.type, agentId: agentId as AgentId, from, to };
      }
      case "result-recorded":
      case "result-drained": {
        const agentId = readNonEmptyString(event.agentId, `${path}.agentId`, innerIssues);
        const delivery: "tool-result" | undefined = event.delivery === "tool-result" ? "tool-result" : undefined;
        if (delivery === undefined) innerIssues.push(`${path}.delivery must be tool-result`);
        return agentId === undefined || delivery === undefined
          ? undefined
          : { sequence, occurredAt, type: event.type, agentId: agentId as AgentId, delivery };
      }

      case "title-updated":
      case "telemetry-updated": {
        const agentId = readNonEmptyString(event.agentId, `${path}.agentId`, innerIssues);
        return agentId === undefined
          ? undefined
          : { sequence, occurredAt, type: event.type, agentId: agentId as AgentId };
      }

      default:
        innerIssues.push(`${path}.type is not a recognized fleet event`);
        return undefined;
    }
  });

  const nextEventSequence = readNonNegativeInteger(
    record.nextEventSequence,
    "fleet.nextEventSequence",
    issues,
  );

  if (
    issues.length > 0 ||
    sessions === undefined ||
    blockingResults === undefined ||
    events === undefined ||
    nextEventSequence === undefined
  ) {
    return { ok: false, issues };
  }
  const agentIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const session of sessions) {
    if (agentIds.has(session.identity.agentId)) {
      issues.push(`fleet.sessions contains duplicate agent ${session.identity.agentId}`);
    }
    if (sessionIds.has(session.sessionId)) {
      issues.push(`fleet.sessions contains duplicate session ${session.sessionId}`);
    }
    agentIds.add(session.identity.agentId);
    sessionIds.add(session.sessionId);
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: 1,
      sessions,
      blockingResults,
      events,
      nextEventSequence,
    },
  };
}

export function parseActivityDto(value: unknown): ValidationResult<ActivityDto> {
  const issues: string[] = [];
  const record = readRecord(value, "activity", issues);
  if (record === undefined) return { ok: false, issues };
  if (record.version !== 1) issues.push("activity.version must be 1");
  if (!Array.isArray(record.entries)) issues.push("activity.entries must be an array");
  if (issues.length > 0) return { ok: false, issues };

  const entries: ActivityEntry[] = [];
  const seen = new Set<string>();
  for (const value of record.entries as readonly unknown[]) {
    const dropped: string[] = [];
    const entry = readRecord(value, "activity.entry", dropped);
    if (entry === undefined) continue;
    const id = readNonEmptyString(entry.id, "id", dropped);
    const at = readTimestamp(entry.at, "at", dropped);
    if (id === undefined || at === undefined || seen.has(id)) continue;
    const issueNumbers = readIssueNumbers(entry.issueNumbers, dropped);
    const pullRequest = entry.pullRequest === undefined
      ? undefined
      : readNonNegativeInteger(entry.pullRequest, "pullRequest", dropped);
    const reason = typeof entry.reason === "string" && entry.reason.trim().length > 0 ? entry.reason : undefined;
    const durationMs = entry.durationMs === undefined
      ? undefined
      : readNonNegativeInteger(entry.durationMs, "durationMs", dropped);

    if (entry.kind === "run") {
      const runId = readNonEmptyString(entry.runId, "runId", dropped);
      const attempt = readNonNegativeInteger(entry.attempt, "attempt", dropped);
      const outcome = RUN_OUTCOMES.includes(entry.outcome as RunOutcome) ? entry.outcome as RunOutcome : undefined;
      const completedIssues = entry.completedIssues === undefined
        ? undefined
        : readNonNegativeInteger(entry.completedIssues, "completedIssues", dropped);
      const totalIssues = entry.totalIssues === undefined
        ? undefined
        : readNonNegativeInteger(entry.totalIssues, "totalIssues", dropped);
      const currentIssue = entry.currentIssue === undefined
        ? undefined
        : readNonNegativeInteger(entry.currentIssue, "currentIssue", dropped);
      if (dropped.length > 0 || runId === undefined || attempt === undefined || outcome === undefined) continue;
      seen.add(id);
      entries.push({
        kind: "run", id, at, runId, attempt, outcome,
        ...(reason === undefined ? {} : { reason }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(completedIssues === undefined ? {} : { completedIssues }),
        ...(totalIssues === undefined ? {} : { totalIssues }),
        ...(currentIssue === undefined ? {} : { currentIssue }),
        ...(issueNumbers === undefined ? {} : { issueNumbers }),
        ...(pullRequest === undefined ? {} : { pullRequest }),
      });
      continue;
    }
    if (entry.kind !== "agent") continue;
    const agentId = readNonEmptyString(entry.agentId, "agentId", dropped);
    const type = parseAgentType(entry.type, "type", dropped);
    const description = readNonEmptyString(entry.description, "description", dropped);
    const title = typeof entry.title === "string" && entry.title.trim() !== "" ? entry.title : undefined;
    const outcome = AGENT_OUTCOMES.includes(entry.outcome as AgentOutcome) ? entry.outcome as AgentOutcome : undefined;
    if (dropped.length > 0 || agentId === undefined || type === undefined || description === undefined || outcome === undefined) continue;
    // A malformed reopen block costs the reopen action, not the row: the outcome
    // is still worth showing.
    const reopen = parseReopenable(entry.reopen);

    seen.add(id);
    entries.push({
      kind: "agent", id, at, agentId: agentId as AgentId, type, description, outcome,
      ...(title === undefined ? {} : { title }),
      ...(reason === undefined ? {} : { reason }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(issueNumbers === undefined ? {} : { issueNumbers }),
      ...(pullRequest === undefined ? {} : { pullRequest }),
      ...(typeof entry.terminalId === "string" && entry.terminalId.length > 0 ? { terminalId: entry.terminalId as TerminalId } : {}),
      ...(reopen === undefined ? {} : { reopen }),
    });
  }
  return { ok: true, value: { version: 1, entries } };
}

function readIssueNumbers(value: unknown, issues: string[]): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { issues.push("issueNumbers must be an array"); return undefined; }
  const numbers = value.map((number, index) => readNonNegativeInteger(number, `issueNumbers[${index}]`, issues));
  return numbers.some((number) => number === undefined) ? undefined : numbers as number[];
}

function parseReopenable(value: unknown): ReopenableSession | undefined {
  if (!isRecord(value)) return undefined;
  const dropped: string[] = [];
  const sessionId = parseSessionId(value.sessionId, "reopen.sessionId", dropped);
  const platform = parseAgentPlatform(value.platform, "reopen.platform", dropped);
  if (sessionId === undefined || platform === undefined) return undefined;
  const issueNumbers = readIssueNumbers(value.issueNumbers, dropped);
  return {
    platform,
    sessionId,
    ...(value.executionMode === "interactive" || value.executionMode === "auto" || value.executionMode === "auto-run" || value.executionMode === "loop" ? { executionMode: value.executionMode } : {}),
    ...(issueNumbers === undefined ? {} : { issueNumbers }),
    ...(value.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
    ...(typeof value.cwd === "string" && value.cwd.trim().length > 0 ? { cwd: value.cwd } : {}),
    ...(value.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
  };
}
