import type { AgentId, AgentPlatformId, IsoTimestamp, SessionId } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import type { AgentPlatform } from "../platform/agent-platform.js";
import type { LifecycleObservation, PlatformLifecycleKind } from "../platform/lifecycle.js";
import type { PromptSubmissions } from "../platform/prompt-submissions.js";
import type { WorkerLifecycleReconciler } from "./lifecycle.js";
import type { BridgeRequestHandler } from "./protocol.js";
import { protocolError } from "./protocol.js";
import type { SessionLifecycleService, SessionStartupProof } from "./session-lifecycle.js";
import type { WorkerHookService } from "./worker-hooks.js";

const ROUTES: Readonly<Record<string, PlatformLifecycleKind>> = {
  "/hooks/session-start": "start",
  "/hooks/prompt-submit": "prompt",
  "/hooks/session-end": "end",
  "/hooks/stop": "stop",
  "/hooks/stop-failure": "failure",
  "/hooks/worker/post-compact": "compaction",
};

export interface PlatformLifecycleRoutesOptions {
  readonly fleet: FleetRegistry;
  readonly platforms: ReadonlyMap<AgentPlatformId, AgentPlatform>;
  readonly sessions: Pick<SessionLifecycleService, "sessionStarted" | "sessionEnded">;
  readonly workers: Pick<WorkerLifecycleReconciler, "stop" | "failure">;
  readonly compactions: Pick<WorkerHookService, "compact">;
  readonly sessionBindings?: readonly SessionBindingTarget[];
  readonly proofs?: SessionStartupProof;
  readonly prompts?: Pick<PromptSubmissions, "submitted">;
  readonly now?: () => Date;
}

/** Process-side owners that must follow a provisional id when it becomes canonical. */
export interface SessionBindingTarget {
  canBindSession(agentId: AgentId, expected: SessionId, actual: SessionId): boolean;
  bindSession(agentId: AgentId, expected: SessionId, actual: SessionId): void;
}

/** Provider payloads end here; downstream services see only LifecycleObservation. */
export function createPlatformLifecycleRoutes(options: PlatformLifecycleRoutesOptions): BridgeRequestHandler {
  return async (request) => {
    const kind = ROUTES[request.url.pathname];
    if (request.method !== "POST" || kind === undefined) return protocolError(404, "not-found", "Route not found");
    try {
      const raw = object(request.body);
      const agentId = requiredString(raw.agentId, "agentId") as AgentId;
      const session = options.fleet.get(agentId);
      if (session === undefined) return accepted(false);
      const platform = options.platforms.get(session.platform);
      if (platform === undefined) throw new Error(`No lifecycle platform is registered for ${session.platform}`);
      const observation = platform.normalizeLifecycle(kind, raw);
      if (observation.agentId !== agentId) throw new Error("Lifecycle normalizer changed agent identity");
      return accepted(await dispatch(options, platform, observation));
    } catch (error) {
      return protocolError(400, "invalid-request", error instanceof Error ? error.message : "Invalid lifecycle event");
    }
  };
}

async function dispatch(options: PlatformLifecycleRoutesOptions, platform: AgentPlatform, observation: LifecycleObservation): Promise<boolean> {
  switch (observation.type) {
    case "start": {
      const current = options.fleet.get(observation.agentId);
      if (current === undefined || current.platform !== platform.id) return false;
      const canonical = platform.bindSession({ sessionId: current.sessionId, binding: current.sessionBinding }, observation.sessionId);
      // A provider may report a different conversation after an in-process
      // resume. The session service owns that grace window and will settle the
      // old Aboard identity; ordinary stale starts still return false.
      if (canonical === undefined) return options.sessions.sessionStarted(observation);
      if (current.sessionBinding === "provisional") {
        const bindings = options.sessionBindings ?? [];
        if (!options.fleet.canBindSession(observation.agentId, current.sessionId, canonical)
          || bindings.some((binding) => !binding.canBindSession(observation.agentId, current.sessionId, canonical))) return false;
        for (const binding of bindings) binding.bindSession(observation.agentId, current.sessionId, canonical);
        if (!options.fleet.bindSession(observation.agentId, current.sessionId, canonical, timestamp(options))) {
          throw new Error("Session identity changed while it was being bound");
        }
      }
      const normalized = { ...observation, sessionId: canonical };
      const acceptedStart = options.sessions.sessionStarted(normalized);
      if (acceptedStart) options.proofs?.discharge(normalized, current.sessionId);
      return acceptedStart;
    }
    case "prompt":
      // Only a delivery waiting on this exact session cares that a prompt landed.
      if (options.fleet.get(observation.agentId)?.sessionId !== observation.sessionId) return false;
      return options.prompts?.submitted(observation.sessionId) ?? false;
    case "end": return options.sessions.sessionEnded(observation);
    case "stop": {
      const session = options.fleet.get(observation.agentId);
      if (session === undefined || session.sessionId !== observation.sessionId) return false;
      // Stop means "the current turn produced a final answer" for an attended
      // TUI, not that its conversation or process ended. Preserve the answer
      // for Fleet/activity settlement and leave the session live.
      if (session.attended === true || session.resultDelivery.mode === "none") {
        return options.fleet.observeAssistantMessage(observation.agentId, observation.lastAssistantMessage, timestamp(options));
      }
      return options.workers.stop(observation);
    }
    case "failure": return options.workers.failure(observation);
    case "compaction": {
      if (options.fleet.get(observation.agentId)?.sessionId !== observation.sessionId) return false;
      options.compactions.compact(observation.agentId, observation.summary);
      return true;
    }
  }
}

function accepted(value: boolean) { return { status: 200 as const, body: { ok: true, accepted: value } }; }
function timestamp(options: PlatformLifecycleRoutesOptions): IsoTimestamp { return (options.now ?? (() => new Date()))().toISOString() as IsoTimestamp; }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Request body must be an object");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}
