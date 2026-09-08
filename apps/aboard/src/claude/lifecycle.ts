import type { AgentId, SessionId, WorkerFailureType } from "../domain/contracts.js";
import { SESSION_END_REASONS, type LifecycleObservation, type PlatformLifecycleKind } from "../platform/lifecycle.js";

export function normalizeClaudeLifecycle(kind: PlatformLifecycleKind, input: unknown): LifecycleObservation {
  const value = object(input);
  const agentId = requiredString(value.agentId, "agentId") as AgentId;
  switch (kind) {
    case "start": {
      const source = optionalString(value.source);
      return { type: "start", agentId, sessionId: sessionId(value.sessionId ?? value.session_id), ...(source === undefined ? {} : { source }) };
    }
    case "end": {
      const reason = requiredString(value.reason, "reason");
      if (!(SESSION_END_REASONS as readonly string[]).includes(reason)) throw new Error(`reason must be one of ${SESSION_END_REASONS.join(", ")}`);
      return { type: "end", agentId, sessionId: sessionId(value.sessionId ?? value.session_id), reason: reason as (typeof SESSION_END_REASONS)[number] };
    }
    case "stop": {
      const exitCode = optionalExitCode(value.exitCode ?? value.exit_code);
      return {
        type: "stop", agentId, sessionId: sessionId(value.sessionId ?? value.session_id),
        cwd: requiredString(value.cwd, "cwd"),
        lastAssistantMessage: requiredString(value.lastAssistantMessage ?? value.lastMessage ?? value.last_assistant_message, "lastAssistantMessage"),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    }
    case "failure": {
      const error = requiredString(value.error, "error");
      const message = optionalString(value.lastAssistantMessage ?? value.last_assistant_message)
        ?? optionalString(value.errorDetails ?? value.error_details)
        ?? error;
      return {
        type: "failure", agentId, sessionId: sessionId(value.sessionId ?? value.session_id),
        failureType: classifyClaudeFailure(error, message), message,
        exitCode: optionalExitCode(value.exitCode ?? value.exit_code) ?? null,
      };
    }
    case "compaction":
      return {
        type: "compaction", agentId, sessionId: sessionId(value.sessionId ?? value.session_id),
        summary: requiredString(value.compactSummary ?? value.compact_summary, "compactSummary"),
      };
  }
}

export function classifyClaudeFailure(error: string, message: string): WorkerFailureType {
  const combined = `${error} ${message}`.toLowerCase();
  if (error === "max_output_tokens" || /context|token limit|max(?:imum)? output/.test(combined)) return "context-exhausted";
  if (/permission|authentication|oauth|not allowed|denied/.test(combined)) return "permission-denied";
  return "crashed";
}

function object(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Lifecycle payload must be an object");
  return input as Record<string, unknown>;
}
function requiredString(input: unknown, name: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return input;
}
function optionalString(input: unknown): string | undefined { return typeof input === "string" && input.length > 0 ? input : undefined; }
function sessionId(input: unknown): SessionId { return requiredString(input, "sessionId") as SessionId; }
function optionalExitCode(input: unknown): number | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (!Number.isInteger(input)) throw new Error("exitCode must be an integer or null");
  return input as number;
}
