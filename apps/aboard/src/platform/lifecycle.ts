import type { AgentId, SessionId, WorkerFailureType } from "../domain/contracts.js";

export const SESSION_END_REASONS = [
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "bypass_permissions_disabled",
  "other",
] as const;

export type SessionEndReason = (typeof SESSION_END_REASONS)[number];
export type PlatformLifecycleKind = "start" | "stop" | "end" | "compaction" | "failure";

export type LifecycleObservation =
  | { readonly type: "start"; readonly agentId: AgentId; readonly sessionId: SessionId; readonly source?: string }
  | { readonly type: "stop"; readonly agentId: AgentId; readonly sessionId: SessionId; readonly cwd: string; readonly lastAssistantMessage: string; readonly exitCode?: number | null }
  | { readonly type: "end"; readonly agentId: AgentId; readonly sessionId: SessionId; readonly reason: SessionEndReason }
  | { readonly type: "compaction"; readonly agentId: AgentId; readonly sessionId: SessionId; readonly summary?: string }
  | { readonly type: "failure"; readonly agentId: AgentId; readonly sessionId: SessionId; readonly failureType: WorkerFailureType; readonly message: string; readonly exitCode: number | null };

export interface PlatformLifecycleNormalizer {
  normalize(kind: PlatformLifecycleKind, payload: unknown): LifecycleObservation;
}
