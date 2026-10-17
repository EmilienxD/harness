import type { AgentId, SessionId } from "../domain/contracts.js";
import type { LifecycleObservation, PlatformLifecycleKind } from "../platform/lifecycle.js";

export function normalizePiLifecycle(kind: PlatformLifecycleKind, payload: unknown): LifecycleObservation {
  if (typeof payload !== "object" || payload === null) throw new Error("Invalid Pi lifecycle event");
  const value = payload as Record<string, unknown>;
  const string = (key: string): string => { const text = value[key]; if (typeof text !== "string" || !text.trim()) throw new Error(`Invalid Pi ${key}`); return text; };
  const common = { agentId: string("agentId") as AgentId, sessionId: string("sessionId") as SessionId };
  switch (kind) {
    case "start": return { type: "start", ...common };
    case "prompt": return { type: "prompt", ...common };
    case "end": return { type: "end", ...common, reason: value.reason === "new" || value.reason === "fork" ? "clear" : value.reason === "resume" ? "resume" : "other" };
    case "compaction": return { type: "compaction", ...common, ...(typeof value.summary === "string" ? { summary: value.summary } : {}) };
    case "stop": return { type: "stop", ...common, cwd: string("cwd"), lastAssistantMessage: string("lastAssistantMessage"), exitCode: 0 };
    case "failure": return { type: "failure", ...common, failureType: value.aborted === true ? "killed" : "crashed", message: string("error"), exitCode: null };
  }
}
