import { ProcessGitClient, isWorkingTreeClean, type GitClient } from "../git/client.js";
import type { TerminalLifecycleEvent } from "../claude/terminals.js";
import {
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
import type { LifecycleObservation } from "../platform/lifecycle.js";

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
  return session.resultDelivery.mode !== "none" && session.attended !== true;
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
    if (!this.#matchesIdentity(observation.agentId, observation.sessionId)) return Promise.resolve(false);
    return this.#once(observation.agentId, async () => {
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

  public failure(observation: Extract<LifecycleObservation, { readonly type: "failure" }>): Promise<boolean> {
    if (!this.#matchesIdentity(observation.agentId, observation.sessionId)) return Promise.resolve(false);
    return this.#once(observation.agentId, async () => {
      return this.#finish(observation.agentId, failure(
        observation.failureType,
        observation.exitCode,
        observation.message,
        this.#telemetry(observation.agentId),
      ));
    });
  }

  public timeout(agentId: AgentId, sessionId: SessionId, lastAssistantMessage: string | null = null): Promise<boolean> {
    if (!this.#matchesIdentity(agentId, sessionId)) return Promise.resolve(false);
    return this.#once(agentId, async () => {
      return this.#finish(agentId, failure("timeout", null, lastAssistantMessage, this.#telemetry(agentId)));
    });
  }

  public terminalClosed(event: Extract<TerminalLifecycleEvent, { type: "terminal-closed" }>): Promise<boolean> {
    if (!this.#matchesIdentity(event.agentId, event.sessionId)) return Promise.resolve(false);
    return this.#once(event.agentId, async () => {
      const type: WorkerFailureType = event.reason === "killed" ? "killed" : "crashed";
      return this.#finish(event.agentId, failure(type, event.exitCode, null, this.#telemetry(event.agentId)));
    });
  }

  public processEnded(observation: { readonly agentId: AgentId; readonly sessionId: SessionId }): Promise<boolean> {
    if (!this.#matchesIdentity(observation.agentId, observation.sessionId)) return Promise.resolve(false);
    return this.#once(observation.agentId, async () => {
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

  #matchesIdentity(agentId: AgentId, sessionId: SessionId): boolean {
    const session = this.options.fleet.get(agentId);
    return session !== undefined && session.sessionId === sessionId;
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
