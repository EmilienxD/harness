import {
  AGENT_TYPES,
  WORKER_FAILURE_TYPES,
  type AgentId,
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
} from "./contracts.js";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INTERACTIVE_AGENT_TYPES: ReadonlySet<AgentType> = new Set([
  "brainstormer",
  "raw",
]);

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

  if (
    totalTokens === undefined ||
    totalDurationMs === undefined ||
    totalToolUseCount === undefined ||
    compactionCount === undefined ||
    (record.resolvedModel !== undefined && resolvedModel === undefined)
  ) {
    return undefined;
  }

  return resolvedModel === undefined
    ? { totalTokens, totalDurationMs, totalToolUseCount, compactionCount }
    : {
        totalTokens,
        totalDurationMs,
        totalToolUseCount,
        compactionCount,
        resolvedModel,
      };
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
    case "mailbox":
    case "none":
      return { mode: record.mode };
    default:
      issues.push(`${path}.mode must be one of: tool-result, mailbox, none`);
      return undefined;
  }
}

export function parseAgentSession(value: unknown): ValidationResult<AgentSession> {
  const issues: string[] = [];
  const record = readRecord(value, "session", issues);
  if (record === undefined) return { ok: false, issues };

  const identity = parseIdentity(record.identity, "session.identity", issues);
  const sessionId = parseSessionId(record.sessionId, "session.sessionId", issues);
  const terminal = parseTerminal(record.terminal, "session.terminal", issues);
  const lifecycle = parseLifecycle(record.lifecycle, "session.lifecycle", issues);
  const resultDelivery = parseResultDelivery(
    record.resultDelivery,
    "session.resultDelivery",
    issues,
  );
  const telemetry = parseTelemetry(record.telemetry, "session.telemetry", issues);
  const issueNumber =
    record.issueNumber === undefined
      ? undefined
      : readNonNegativeInteger(record.issueNumber, "session.issueNumber", issues);

  if (identity !== undefined && resultDelivery !== undefined) {
    if (
      (identity.type === "manager" ||
        INTERACTIVE_AGENT_TYPES.has(identity.type)) &&
      resultDelivery.mode !== "none"
    ) {
      issues.push(
        `session.resultDelivery.mode must be none for ${identity.type} agents`,
      );
    }
    if (
      identity.type !== "manager" &&
      !INTERACTIVE_AGENT_TYPES.has(identity.type) &&
      resultDelivery.mode === "none"
    ) {
      issues.push(
        `session.resultDelivery.mode must deliver a result for ${identity.type} agents`,
      );
    }
    if (
      lifecycle?.status === "awaiting-user" &&
      !INTERACTIVE_AGENT_TYPES.has(identity.type)
    ) {
      issues.push(
        `session.lifecycle.status awaiting-user is only legal for interactive agents`,
      );
    }
  }

  if (
    issues.length > 0 ||
    identity === undefined ||
    sessionId === undefined ||
    terminal === undefined ||
    lifecycle === undefined ||
    resultDelivery === undefined ||
    telemetry === undefined ||
    (record.issueNumber !== undefined && issueNumber === undefined)
  ) {
    return { ok: false, issues };
  }

  const base = {
    identity,
    sessionId,
    terminal,
    lifecycle,
    resultDelivery,
    telemetry,
  };
  return issueNumber === undefined
    ? { ok: true, value: base }
    : { ok: true, value: { ...base, issueNumber } };
}
