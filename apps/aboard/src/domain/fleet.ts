import { isInteractiveAgentType } from "./contracts.js";
import type {
  AgentId,
  AgentLifecycle,
  AgentSession,
  AgentTelemetry,
  IsoTimestamp,
  SessionId,
  WorkerResult,
} from "./contracts.js";

export type FleetStateErrorCode =
  | "duplicate-agent"
  | "duplicate-session"
  | "unknown-agent"
  | "invalid-transition"
  | "invalid-result";

export class FleetStateError extends Error {
  public constructor(
    public readonly code: FleetStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FleetStateError";
  }
}


export type FleetEvent =
  | {
      readonly sequence: number;
      readonly occurredAt: IsoTimestamp;
      readonly type: "agent-registered";
      readonly agentId: AgentId;
      readonly sessionId: SessionId;
    }
  | {
      readonly sequence: number;
      readonly occurredAt: IsoTimestamp;
      readonly type: "agent-removed";
      readonly agentId: AgentId;
      readonly sessionId: SessionId;
    }
  | {
      readonly sequence: number;
      readonly occurredAt: IsoTimestamp;
      readonly type: "lifecycle-transitioned";
      readonly agentId: AgentId;
      readonly from: AgentLifecycle["status"];
      readonly to: AgentLifecycle["status"];
    }
  | {
      readonly sequence: number;
      readonly occurredAt: IsoTimestamp;
      readonly type: "result-recorded" | "result-drained";
      readonly agentId: AgentId;
      readonly delivery: "tool-result";
    }
  | {
      readonly sequence: number;
      readonly occurredAt: IsoTimestamp;
      readonly type: "telemetry-updated";
      readonly agentId: AgentId;
    };

type NewFleetEvent = FleetEvent extends infer Event
  ? Event extends FleetEvent
    ? Omit<Event, "sequence" | "occurredAt">
    : never
  : never;

export const MAX_FLEET_EVENTS = 100;

export interface FleetPersistenceDto {
  readonly version: 1;
  readonly sessions: readonly AgentSession[];
  readonly blockingResults: readonly { readonly agentId: AgentId; readonly result: WorkerResult }[];
  readonly events: readonly FleetEvent[];
  readonly nextEventSequence: number;
}

const TRANSITIONS: Readonly<Record<AgentLifecycle["status"], ReadonlySet<AgentLifecycle["status"]>>> = {
  starting: new Set(["running", "completed", "failed"]),
  running: new Set(["awaiting-user", "completed", "failed"]),
  "awaiting-user": new Set(["running", "completed", "failed"]),
  completed: new Set(["starting"]),
  failed: new Set(["starting"]),
};

export class FleetRegistry {
  private readonly sessionsByAgent = new Map<AgentId, AgentSession>();
  private readonly agentBySession = new Map<SessionId, AgentId>();
  private readonly blockingResults = new Map<AgentId, WorkerResult>();
  private readonly eventHistory: FleetEvent[] = [];
  private nextEventSequence = 1;
  private readonly listeners = new Set<(event: FleetEvent) => void>();

  public onDidChange(listener: (event: FleetEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public static restore(dto: FleetPersistenceDto): FleetRegistry {
    const registry = new FleetRegistry();
    for (const session of dto.sessions) {
      registry.sessionsByAgent.set(session.identity.agentId, session);
      registry.agentBySession.set(session.sessionId, session.identity.agentId);
    }
    for (const entry of dto.blockingResults) {
      registry.blockingResults.set(entry.agentId, entry.result);
    }
    registry.eventHistory.push(...dto.events.slice(-MAX_FLEET_EVENTS));
    registry.nextEventSequence = dto.nextEventSequence;
    return registry;
  }

  public register(session: AgentSession, occurredAt: IsoTimestamp): void {
    const agentId = session.identity.agentId;
    if (this.sessionsByAgent.has(agentId)) {
      throw new FleetStateError("duplicate-agent", `Agent ${agentId} is already registered`);
    }
    if (this.agentBySession.has(session.sessionId)) {
      throw new FleetStateError(
        "duplicate-session",
        `Session ${session.sessionId} is already registered`,
      );
    }
    if (session.lifecycle.status !== "starting" || session.lastResult !== undefined) {
      throw new FleetStateError(
        "invalid-transition",
        "New agents must register in starting state without a prior result",
      );
    }

    this.sessionsByAgent.set(agentId, session);
    this.agentBySession.set(session.sessionId, agentId);
    this.record({ type: "agent-registered", agentId, sessionId: session.sessionId }, occurredAt);
  }

  public remove(agentId: AgentId, occurredAt: IsoTimestamp): void {
    const session = this.sessionsByAgent.get(agentId);
    if (session === undefined) return;

    this.sessionsByAgent.delete(agentId);
    this.agentBySession.delete(session.sessionId);
    this.blockingResults.delete(agentId);
    this.record({ type: "agent-removed", agentId, sessionId: session.sessionId }, occurredAt);
  }

  /** Discards all live state, used when the project's `.abd/` directory disappears. */
  public clear(occurredAt: IsoTimestamp): void {
    for (const agentId of [...this.sessionsByAgent.keys()]) this.remove(agentId, occurredAt);
    this.blockingResults.clear();
  }

  public get(agentId: AgentId): AgentSession | undefined {
    return this.sessionsByAgent.get(agentId);
  }

  public getBySession(sessionId: SessionId): AgentSession | undefined {
    const agentId = this.agentBySession.get(sessionId);
    return agentId === undefined ? undefined : this.sessionsByAgent.get(agentId);
  }

  public list(): readonly AgentSession[] {
    return [...this.sessionsByAgent.values()];
  }


  public recordCompaction(agentId: AgentId, summary: string, occurredAt: IsoTimestamp): void {
    const session = this.requireSession(agentId);
    const telemetry = { ...session.telemetry, compactionCount: session.telemetry.compactionCount + 1 };
    this.sessionsByAgent.set(agentId, { ...session, telemetry, compactSummaries: [...(session.compactSummaries ?? []), summary] });
    this.record({ type: "telemetry-updated", agentId }, occurredAt);
  }

  public transition(agentId: AgentId, lifecycle: AgentLifecycle, occurredAt: IsoTimestamp): void {
    const session = this.requireSession(agentId);
    const from = session.lifecycle.status;
    if (!TRANSITIONS[from].has(lifecycle.status)) {
      throw new FleetStateError(
        "invalid-transition",
        `Cannot transition agent ${agentId} from ${from} to ${lifecycle.status}`,
      );
    }
    if (lifecycle.status === "awaiting-user" && !isInteractiveAgentType(session.identity.type)) {
      throw new FleetStateError(
        "invalid-transition",
        `Agent type ${session.identity.type} cannot await user input`,
      );
    }
    this.sessionsByAgent.set(agentId, { ...session, lifecycle });
    this.record({ type: "lifecycle-transitioned", agentId, from, to: lifecycle.status }, occurredAt);
  }

  public restart(
    agentId: AgentId,
    terminal: AgentSession["terminal"],
    startedAt: IsoTimestamp,
    sessionId?: SessionId,
    attended?: boolean,
    resultDelivery?: AgentSession["resultDelivery"],
  ): void {
    const session = this.requireSession(agentId);
    if (session.lifecycle.status !== "completed" && session.lifecycle.status !== "failed") {
      throw new FleetStateError("invalid-transition", `Agent ${agentId} is still active`);
    }
    if (sessionId !== undefined && sessionId !== session.sessionId) {
      const owner = this.agentBySession.get(sessionId);
      if (owner !== undefined && owner !== agentId) {
        throw new FleetStateError("duplicate-session", `Session ${sessionId} is already registered`);
      }
      this.agentBySession.delete(session.sessionId);
      this.agentBySession.set(sessionId, agentId);
    }
    const from = session.lifecycle.status;
    const { lastResult: _lastResult, attended: _attended, ...withoutResult } = session;
    this.sessionsByAgent.set(agentId, {
      ...withoutResult,
      ...(attended === undefined ? (session.attended === true ? { attended: true as const } : {}) : attended ? { attended: true as const } : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(resultDelivery === undefined ? {} : { resultDelivery }),
      terminal,
      lifecycle: { status: "starting", startedAt },
    });
    this.record({ type: "lifecycle-transitioned", agentId, from, to: "starting" }, startedAt);
  }

  /** Reattaches an active persisted session to a new VS Code terminal. */
  public reattach(
    agentId: AgentId,
    terminal: AgentSession["terminal"],
    startedAt: IsoTimestamp,
    sessionId?: SessionId,
    resultDelivery?: AgentSession["resultDelivery"],
    attended?: boolean,
  ): void {
    const session = this.requireSession(agentId);
    if (
      session.lifecycle.status !== "starting" &&
      session.lifecycle.status !== "running" &&
      session.lifecycle.status !== "awaiting-user"
    ) {
      throw new FleetStateError("invalid-transition", `Agent ${agentId} is not active`);
    }
    if (sessionId !== undefined && sessionId !== session.sessionId) {
      const owner = this.agentBySession.get(sessionId);
      if (owner !== undefined && owner !== agentId) {
        throw new FleetStateError("duplicate-session", `Session ${sessionId} is already registered`);
      }
      this.agentBySession.delete(session.sessionId);
      this.agentBySession.set(sessionId, agentId);
    }
    const from = session.lifecycle.status;
    const { attended: _attended, ...withoutAttended } = session;
    this.sessionsByAgent.set(agentId, {
      ...withoutAttended,
      ...(attended === undefined ? (session.attended === true ? { attended: true as const } : {}) : attended ? { attended: true as const } : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(resultDelivery === undefined ? {} : { resultDelivery }),
      terminal,
      lifecycle: { status: "starting", startedAt },
    });
    this.record({ type: "lifecycle-transitioned", agentId, from, to: "starting" }, startedAt);
  }

  public updateTelemetry(agentId: AgentId, telemetry: AgentTelemetry, occurredAt: IsoTimestamp): void {
    const session = this.requireSession(agentId);
    if (telemetry.compactionCount < session.telemetry.compactionCount) {
      throw new FleetStateError("invalid-transition", "Compaction count cannot decrease");
    }
    this.sessionsByAgent.set(agentId, { ...session, telemetry });
    this.record({ type: "telemetry-updated", agentId }, occurredAt);
  }

  public observeAssistantMessage(agentId: AgentId, message: string, occurredAt: IsoTimestamp): boolean {
    if (message.trim().length === 0) return false;
    const session = this.sessionsByAgent.get(agentId);
    if (session === undefined) return false;
    if (session.lastObservedAssistantMessage === message) return true;
    this.sessionsByAgent.set(agentId, { ...session, lastObservedAssistantMessage: message });
    this.record({ type: "telemetry-updated", agentId }, occurredAt);
    return true;
  }


  public recordResult(agentId: AgentId, result: WorkerResult, occurredAt: IsoTimestamp): void {
    const session = this.requireSession(agentId);
    if (session.lifecycle.status !== "completed" && session.lifecycle.status !== "failed") {
      throw new FleetStateError("invalid-result", `Agent ${agentId} has not finished`);
    }
    const expectedOutcome = session.lifecycle.status === "completed" ? "succeeded" : "failed";
    if (result.outcome !== expectedOutcome) {
      throw new FleetStateError("invalid-result", `Result does not match ${session.lifecycle.status} lifecycle`);
    }
    this.sessionsByAgent.set(agentId, { ...session, telemetry: result.telemetry, lastResult: result });
    if (session.resultDelivery.mode !== "tool-result") {
      throw new FleetStateError("invalid-result", `Agent ${agentId} has no result delivery route`);
    }
    this.blockingResults.set(agentId, result);
    this.record({ type: "result-recorded", agentId, delivery: "tool-result" }, occurredAt);
  }

  public takeBlockingResult(agentId: AgentId, occurredAt: IsoTimestamp): WorkerResult | undefined {
    const result = this.blockingResults.get(agentId);
    if (result === undefined) return undefined;
    this.blockingResults.delete(agentId);
    this.record({ type: "result-drained", agentId, delivery: "tool-result" }, occurredAt);
    return result;
  }


  public events(): readonly FleetEvent[] {
    return [...this.eventHistory];
  }

  /** Monotonic change token used to close the check-then-subscribe long-poll race. */
  public revision(): number {
    return this.nextEventSequence - 1;
  }

  public toPersistenceDto(): FleetPersistenceDto {
    return {
      version: 1,
      sessions: this.list(),
      blockingResults: [...this.blockingResults].map(([agentId, result]) => ({ agentId, result })),
      events: this.events(),
      nextEventSequence: this.nextEventSequence,
    };
  }

  private requireSession(agentId: AgentId): AgentSession {
    const session = this.sessionsByAgent.get(agentId);
    if (session === undefined) {
      throw new FleetStateError("unknown-agent", `Agent ${agentId} is not registered`);
    }
    return session;
  }


  private record(
    event: NewFleetEvent,
    occurredAt: IsoTimestamp,
  ): void {
    const recorded = { ...event, sequence: this.nextEventSequence++, occurredAt } as FleetEvent;
    this.eventHistory.push(recorded);
    if (this.eventHistory.length > MAX_FLEET_EVENTS) this.eventHistory.shift();
    for (const listener of this.listeners) listener(recorded);
  }
}

