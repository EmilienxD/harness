import { ProcessGitClient, isWorkingTreeClean, type GitClient } from "../git/client.js";
import type { TerminalLifecycleEvent } from "../claude/terminals.js";
import {
  isInteractiveAgentType,
  type AgentId,
  type AgentSession,
  type AgentTelemetry,
  type IsoTimestamp,
  type SessionId,
  type WorkerFailureType,
  type WorkerResult,
} from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import type { WriteLease } from "../domain/lease.js";
import type { BridgeRequestHandler } from "./protocol.js";
import { protocolError } from "./protocol.js";

export interface WorkingTreeInspector {
  isClean(cwd: string): Promise<boolean>;
}

/** Thin adapter over the git boundary; the cwd is the worker's, not the host's. */
export class GitWorkingTreeInspector implements WorkingTreeInspector {
  public constructor(private readonly client: (cwd: string) => GitClient = (cwd) => new ProcessGitClient(cwd)) {}

  public async isClean(cwd: string): Promise<boolean> {
    return isWorkingTreeClean(await this.client(cwd).status());
  }
}

export interface WorkerCompletionSink {
  complete(agentId: AgentId, result: WorkerResult): boolean;
}

export function reportsResult(session: AgentSession): boolean {
  return session.resultDelivery.mode !== "none"
    && session.identity.type !== "manager"
    && !isInteractiveAgentType(session.identity.type);
}

export interface WorkerLifecycleReconcilerOptions {
  readonly fleet: FleetRegistry;
  readonly lease: WriteLease;
  readonly completions: WorkerCompletionSink;
  readonly workingTree: WorkingTreeInspector;
  /** Observes the classified terminal outcome before the fleet row is retired. */
  readonly onFinished?: (session: AgentSession, result: WorkerResult) => void;
}

export interface StopObservation {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly lastAssistantMessage: string;
  readonly exitCode?: number | null;
}

export interface StopFailureObservation {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly error: string;
  readonly errorDetails?: string;
  readonly lastAssistantMessage?: string;
  readonly exitCode?: number | null;
}

const EMPTY_TELEMETRY: AgentTelemetry = {
  totalTokens: 0,
  totalDurationMs: 0,
  totalToolUseCount: 0,
  compactionCount: 0,
};

export class WorkerLifecycleReconciler {
  readonly #settling = new Map<AgentId, Promise<boolean>>();

  public constructor(private readonly options: WorkerLifecycleReconcilerOptions) {}

  public stop(observation: StopObservation): Promise<boolean> {
    return this.#once(observation.agentId, async () => {
      this.#requireIdentity(observation.agentId, observation.sessionId);
      const exitCode = observation.exitCode ?? 0;
      if (exitCode !== 0) {
        return this.#finish(observation.agentId, failure("crashed", exitCode, observation.lastAssistantMessage));
      }
      const expectsUncommittedTree = this.options.fleet.get(observation.agentId)?.expectsUncommittedTree === true;
      if (!expectsUncommittedTree && this.options.lease.current()?.agentId === observation.agentId) {
        let clean = false;
        try {
          clean = await this.options.workingTree.isClean(observation.cwd);
        } catch {
          return this.#finish(observation.agentId, failure("crashed", exitCode, observation.lastAssistantMessage));
        }
        if (!clean) {
          return this.#finish(observation.agentId, failure("no-commit", exitCode, observation.lastAssistantMessage));
        }
      }
      return this.#finish(observation.agentId, {
        outcome: "succeeded",
        exitCode,
        lastAssistantMessage: observation.lastAssistantMessage,
        telemetry: this.#telemetry(observation.agentId),
      });
    });
  }

  public stopFailure(observation: StopFailureObservation): Promise<boolean> {
    return this.#once(observation.agentId, async () => {
      this.#requireIdentity(observation.agentId, observation.sessionId);
      const message = observation.lastAssistantMessage ?? observation.errorDetails ?? observation.error;
      return this.#finish(observation.agentId, failure(
        classifyStopFailure(observation.error, message),
        observation.exitCode ?? null,
        message,
        this.#telemetry(observation.agentId),
      ));
    });
  }

  public timeout(agentId: AgentId, sessionId: SessionId, lastAssistantMessage: string | null = null): Promise<boolean> {
    return this.#once(agentId, async () => {
      this.#requireIdentity(agentId, sessionId);
      return this.#finish(agentId, failure("timeout", null, lastAssistantMessage, this.#telemetry(agentId)));
    });
  }

  public terminalClosed(event: Extract<TerminalLifecycleEvent, { type: "terminal-closed" }>): Promise<boolean> {
    return this.#once(event.agentId, async () => {
      this.#requireIdentity(event.agentId, event.sessionId);
      const type: WorkerFailureType = event.reason === "killed" ? "killed" : "crashed";
      return this.#finish(event.agentId, failure(type, event.exitCode, null, this.#telemetry(event.agentId)));
    });
  }

  public processEnded(observation: { readonly agentId: AgentId; readonly sessionId: SessionId }): Promise<boolean> {
    return this.#once(observation.agentId, async () => {
      this.#requireIdentity(observation.agentId, observation.sessionId);
      return this.#finish(observation.agentId, failure("crashed", null, null, this.#telemetry(observation.agentId)));
    });
  }

  #once(agentId: AgentId, operation: () => Promise<boolean>): Promise<boolean> {
    const existing = this.#settling.get(agentId);
    if (existing !== undefined) return existing.then(() => false);
    const session = this.options.fleet.get(agentId);
    if (session?.lifecycle.status === "completed" || session?.lifecycle.status === "failed") return Promise.resolve(false);
    const pending = operation().finally(() => this.#settling.delete(agentId));
    this.#settling.set(agentId, pending);
    return pending;
  }

  #finish(agentId: AgentId, result: WorkerResult): boolean {
    try {
      const session = this.options.fleet.get(agentId);
      const completed = this.options.completions.complete(agentId, result);
      if (completed && session !== undefined) this.options.onFinished?.(session, result);
      return completed;
    } finally {
      this.options.lease.releaseForTerminalOutcome(agentId, new Date().toISOString() as IsoTimestamp, "worker lifecycle reconciled");
    }
  }

  #requireIdentity(agentId: AgentId, sessionId: SessionId): void {
    const session = this.options.fleet.get(agentId);
    if (session === undefined || session.sessionId !== sessionId) throw new Error("Unknown aboard agent/session identity");
  }

  #telemetry(agentId: AgentId): AgentTelemetry {
    return this.options.fleet.get(agentId)?.telemetry ?? EMPTY_TELEMETRY;
  }
}

function failure(
  type: WorkerFailureType,
  exitCode: number | null,
  lastAssistantMessage: string | null,
  telemetry: AgentTelemetry = EMPTY_TELEMETRY,
): WorkerResult {
  return { outcome: "failed", failure: { type, exitCode, lastAssistantMessage }, telemetry };
}

export function classifyStopFailure(error: string, message: string): WorkerFailureType {
  const combined = `${error} ${message}`.toLowerCase();
  if (error === "max_output_tokens" || /context|token limit|max(?:imum)? output/.test(combined)) return "context-exhausted";
  if (/permission|authentication|oauth|not allowed|denied/.test(combined)) return "permission-denied";
  return "crashed";
}

export function createWorkerLifecycleRoutes(reconciler: WorkerLifecycleReconciler): BridgeRequestHandler {
  return async (request) => {
    if (request.method !== "POST") return protocolError(404, "not-found", "Route not found");
    try {
      if (request.url.pathname === "/hooks/stop") {
        const value = parseStop(request.body);
        return { status: 200, body: { ok: true, accepted: await reconciler.stop(value) } };
      }
      if (request.url.pathname === "/hooks/stop-failure") {
        const value = parseStopFailure(request.body);
        return { status: 200, body: { ok: true, accepted: await reconciler.stopFailure(value) } };
      }
      if (request.url.pathname === "/hooks/timeout") {
        const value = object(request.body);
        return { status: 200, body: { ok: true, accepted: await reconciler.timeout(agentId(value.agentId), sessionId(value.sessionId), optionalString(value.lastAssistantMessage) ?? null) } };
      }
      return protocolError(404, "not-found", "Route not found");
    } catch (error) {
      return protocolError(400, "invalid-request", error instanceof Error ? error.message : "Invalid lifecycle event");
    }
  };
}

function parseStop(input: unknown): StopObservation {
  const value = object(input);
  const exitCode = optionalExitCode(value.exitCode);
  return {
    agentId: agentId(value.agentId), sessionId: sessionId(value.sessionId ?? value.session_id),
    cwd: requiredString(value.cwd, "cwd"),
    lastAssistantMessage: requiredString(value.lastAssistantMessage ?? value.lastMessage ?? value.last_assistant_message, "lastAssistantMessage"),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function parseStopFailure(input: unknown): StopFailureObservation {
  const value = object(input);
  const errorDetails = optionalString(value.errorDetails ?? value.error_details);
  const lastAssistantMessage = optionalString(value.lastAssistantMessage ?? value.last_assistant_message);
  const exitCode = optionalExitCode(value.exitCode);
  return {
    agentId: agentId(value.agentId), sessionId: sessionId(value.sessionId ?? value.session_id),
    error: requiredString(value.error, "error"),
    ...(errorDetails === undefined ? {} : { errorDetails }),
    ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function object(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Request body must be an object");
  return input as Record<string, unknown>;
}
function requiredString(input: unknown, name: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return input;
}
function optionalString(input: unknown): string | undefined { return typeof input === "string" && input.length > 0 ? input : undefined; }
function agentId(input: unknown): AgentId { return requiredString(input, "agentId") as AgentId; }
function sessionId(input: unknown): SessionId { return requiredString(input, "sessionId") as SessionId; }
function optionalExitCode(input: unknown): number | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (!Number.isInteger(input)) throw new Error("exitCode must be an integer or null");
  return input as number;
}
