import type { AgentId, SessionId } from "../domain/contracts.js";
import type { LifecycleObservation, PlatformLifecycleKind } from "../platform/lifecycle.js";

export function normalizeChatGptLifecycle(kind: PlatformLifecycleKind, input: unknown): LifecycleObservation {
  const value = object(input);
  const agentId = requiredString(value.agentId, "agentId") as AgentId;
  const sessionId = requiredString(value.sessionId ?? value.session_id, "sessionId") as SessionId;
  switch (kind) {
    case "start": {
      const source = optionalString(value.source);
      return { type: "start", agentId, sessionId, ...(source === undefined ? {} : { source }) };
    }
    case "end":
      return { type: "end", agentId, sessionId, reason: "other" };
    case "stop":
      return {
        type: "stop",
        agentId,
        sessionId,
        cwd: requiredString(value.cwd, "cwd"),
        lastAssistantMessage: requiredString(value.lastAssistantMessage ?? value.last_assistant_message, "lastAssistantMessage"),
      };
    case "compaction":
      return { type: "compaction", agentId, sessionId };
    case "prompt":
      return { type: "prompt", agentId, sessionId };
    case "failure":
      throw new Error(`ChatGPT does not support ${kind} lifecycle observations in this release`);
  }
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
