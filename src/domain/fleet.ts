import { isInteractiveAgentType } from "./contracts.js";
import type {
  AgentId,
  AgentLifecycle,
  AgentSession,
  AgentTelemetry,
  ChildAgentNode,
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

export interface DeferredNotification {
  readonly id: number;
  readonly occurredAt: IsoTimestamp;
  readonly message: string;
}

export interface DeferredNotificationSummary {
  readonly count: number;
  readonly firstOccurredAt: IsoTimestamp;
  readonly lastOccurredAt: IsoTimestamp;
}

export interface DeferredNotificationDelivery {
  readonly notifications: readonly DeferredNotification[];
  readonly summarized?: DeferredNotificationSummary;
}

export interface NotificationSummaryPolicy {
  readonly maxDetailedEntries: number;
}

export const DEFAULT_NOTIFICATION_SUMMARY_POLICY: NotificationSummaryPolicy = {
  maxDetailedEntries: 20,
};

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
      readonly delivery: "tool-result" | "mailbox";
    }
  | {
      readonly sequence: number;
      readonly occurredAt: IsoTimestamp;
      readonly type: "notification-enqueued" | "notifications-drained";
      readonly managerAgentId: AgentId;
      readonly count: number;
    }
  | {
      readonly sequence: number;
      readonly occurredAt: IsoTimestamp;
      readonly type: "telemetry-updated";
      readonly agentId: AgentId;
    }
  | {
      readonly sequence: number;
      readonly occurredAt: IsoTimestamp;
      readonly type: "child-agent-started" | "child-agent-finished" | "child-agent-telemetry-updated";
      readonly agentId: AgentId;
      readonly childAgentId: string;
    };

type NewFleetEvent = FleetEvent extends infer Event
  ? Event extends FleetEvent
    ? Omit<Event, "sequence" | "occurredAt">
    : never
  : never;

export interface MailboxEntry {
  readonly agentId: AgentId;
  readonly result: WorkerResult;
}

export interface FleetPersistenceDto {
  readonly version: 1;
  readonly sessions: readonly AgentSession[];
  readonly childAgents?: readonly ChildAgentNode[];
  readonly blockingResults: readonly MailboxEntry[];
  readonly mailboxes: readonly {
    readonly managerAgentId: AgentId;
    readonly entries: readonly MailboxEntry[];
  }[];
  readonly deferredNotifications: readonly {
    readonly managerAgentId: AgentId;
    readonly entries: readonly DeferredNotification[];
  }[];
  readonly events: readonly FleetEvent[];
  readonly nextNotificationId: number;
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
  private readonly childAgentsById = new Map<string, ChildAgentNode>();
  private readonly agentBySession = new Map<SessionId, AgentId>();
  private readonly blockingResults = new Map<AgentId, WorkerResult>();
  private readonly mailboxes = new Map<AgentId, MailboxEntry[]>();
  private readonly notifications = new Map<AgentId, DeferredNotification[]>();
  private readonly eventHistory: FleetEvent[] = [];
  private nextNotificationId = 1;
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
    for (const child of dto.childAgents ?? []) registry.childAgentsById.set(child.agentId, child);
    for (const entry of dto.blockingResults) {
      registry.blockingResults.set(entry.agentId, entry.result);
    }
    for (const mailbox of dto.mailboxes) {
      registry.mailboxes.set(mailbox.managerAgentId, [...mailbox.entries]);
    }
    for (const queue of dto.deferredNotifications) {
      registry.notifications.set(queue.managerAgentId, [...queue.entries]);
    }
    registry.eventHistory.push(...dto.events);
    registry.nextNotificationId = dto.nextNotificationId;
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
    if (session.resultDelivery.mode === "mailbox") {
      const manager = this.sessionsByAgent.get(session.resultDelivery.managerAgentId);
      if (manager?.identity.type !== "manager") {
        throw new FleetStateError(
          "unknown-agent",
          `Mailbox manager ${session.resultDelivery.managerAgentId} is not registered`,
        );
      }
    }
    this.sessionsByAgent.set(agentId, session);
    this.agentBySession.set(session.sessionId, agentId);
    this.record({ type: "agent-registered", agentId, sessionId: session.sessionId }, occurredAt);
  }

  /**
   * Forgets an agent completely. A dead terminal is not a fleet member: the
   * session, its children, and any undelivered results go with it, so nothing
   * in the tree or the persisted snapshot outlives the process it described.
   */
  public remove(agentId: AgentId, occurredAt: IsoTimestamp): void {
    const session = this.sessionsByAgent.get(agentId);
    if (session === undefined) return;
    this.sessionsByAgent.delete(agentId);
    this.agentBySession.delete(session.sessionId);
    this.blockingResults.delete(agentId);
    this.mailboxes.delete(agentId);
    this.notifications.delete(agentId);
    for (const [managerAgentId, entries] of this.mailboxes) {
      const kept = entries.filter((entry) => entry.agentId !== agentId);
      if (kept.length === entries.length) continue;
      if (kept.length === 0) this.mailboxes.delete(managerAgentId);
      else this.mailboxes.set(managerAgentId, kept);
    }
    for (const [childId, child] of this.childAgentsById) {
      if (child.parentAgentId === agentId) this.childAgentsById.delete(childId);
    }
    this.record({ type: "agent-removed", agentId, sessionId: session.sessionId }, occurredAt);
  }

  /** Discards all live state, used when the project's `.aboard/` directory disappears. */
  public clear(occurredAt: IsoTimestamp): void {
    for (const agentId of [...this.sessionsByAgent.keys()]) this.remove(agentId, occurredAt);
    this.childAgentsById.clear();
    this.blockingResults.clear();
    this.mailboxes.clear();
    this.notifications.clear();
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

  public listChildren(parentAgentId?: AgentId): readonly ChildAgentNode[] {
    const children = [...this.childAgentsById.values()];
    return parentAgentId === undefined ? children : children.filter((child) => child.parentAgentId === parentAgentId);
  }

  public startChild(child: ChildAgentNode, occurredAt: IsoTimestamp): void {
    this.requireSession(child.parentAgentId);
    if (this.childAgentsById.has(child.agentId)) throw new FleetStateError("duplicate-agent", `Child agent ${child.agentId} is already registered`);
    if (child.status !== "running") throw new FleetStateError("invalid-transition", "New child agents must start in running state");
    this.childAgentsById.set(child.agentId, child);
    this.record({ type: "child-agent-started", agentId: child.parentAgentId, childAgentId: child.agentId }, occurredAt);
  }

  public finishChild(parentAgentId: AgentId, childAgentId: string, result: string | undefined, occurredAt: IsoTimestamp): void {
    const child = this.childAgentsById.get(childAgentId);
    if (child === undefined || child.parentAgentId !== parentAgentId) throw new FleetStateError("unknown-agent", `Child agent ${childAgentId} is not registered for ${parentAgentId}`);
    if (child.status === "completed") return;
    this.childAgentsById.set(childAgentId, { ...child, status: "completed", finishedAt: occurredAt, ...(result === undefined ? {} : { result }) });
    this.record({ type: "child-agent-finished", agentId: parentAgentId, childAgentId }, occurredAt);
  }

  public updateChildTelemetry(parentAgentId: AgentId, childAgentId: string, telemetry: AgentTelemetry, result: string | undefined, occurredAt: IsoTimestamp): void {
    const child = this.childAgentsById.get(childAgentId);
    if (child === undefined || child.parentAgentId !== parentAgentId) throw new FleetStateError("unknown-agent", `Child agent ${childAgentId} is not registered for ${parentAgentId}`);
    this.childAgentsById.set(childAgentId, { ...child, telemetry, ...(result === undefined ? {} : { result }) });
    this.record({ type: "child-agent-telemetry-updated", agentId: parentAgentId, childAgentId }, occurredAt);
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

  /**
   * Relaunches a finished agent under its existing identity. `sessionId` is
   * passed only when the relaunch starts a fresh conversation rather than
   * resuming the recorded one — "New Manager" keeps the agent id but replaces
   * the session, and hook routing resolves by session id.
   */
  public restart(
    agentId: AgentId,
    terminal: AgentSession["terminal"],
    startedAt: IsoTimestamp,
    sessionId?: SessionId,
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
    const { lastResult: _lastResult, ...withoutResult } = session;
    this.sessionsByAgent.set(agentId, {
      ...withoutResult,
      ...(sessionId === undefined ? {} : { sessionId }),
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
    switch (session.resultDelivery.mode) {
      case "tool-result":
        this.blockingResults.set(agentId, result);
        break;
      case "mailbox": {
        const entries = this.mailboxes.get(session.resultDelivery.managerAgentId) ?? [];
        entries.push({ agentId, result });
        this.mailboxes.set(session.resultDelivery.managerAgentId, entries);
        break;
      }
      case "none":
        throw new FleetStateError("invalid-result", `Agent ${agentId} has no result delivery route`);
    }
    this.record({ type: "result-recorded", agentId, delivery: session.resultDelivery.mode }, occurredAt);
  }

  public takeBlockingResult(agentId: AgentId, occurredAt: IsoTimestamp): WorkerResult | undefined {
    const result = this.blockingResults.get(agentId);
    if (result === undefined) return undefined;
    this.blockingResults.delete(agentId);
    this.record({ type: "result-drained", agentId, delivery: "tool-result" }, occurredAt);
    return result;
  }

  public drainMailbox(managerAgentId: AgentId, occurredAt: IsoTimestamp): readonly MailboxEntry[] {
    const entries = this.mailboxes.get(managerAgentId) ?? [];
    if (entries.length === 0) return [];
    this.mailboxes.delete(managerAgentId);
    for (const entry of entries) {
      this.record({ type: "result-drained", agentId: entry.agentId, delivery: "mailbox" }, occurredAt);
    }
    return entries;
  }

  public enqueueNotification(managerAgentId: AgentId, message: string, occurredAt: IsoTimestamp): void {
    if (message.trim().length === 0) {
      throw new FleetStateError("invalid-result", "Deferred notification must not be empty");
    }
    const manager = this.requireSession(managerAgentId);
    if (manager.identity.type !== "manager") {
      throw new FleetStateError("invalid-result", `Agent ${managerAgentId} is not a Manager`);
    }
    const queue = this.notifications.get(managerAgentId) ?? [];
    queue.push({ id: this.nextNotificationId++, occurredAt, message });
    this.notifications.set(managerAgentId, queue);
    this.record({ type: "notification-enqueued", managerAgentId, count: 1 }, occurredAt);
  }

  public drainNotifications(
    managerAgentId: AgentId,
    occurredAt: IsoTimestamp,
    policy: NotificationSummaryPolicy = DEFAULT_NOTIFICATION_SUMMARY_POLICY,
  ): DeferredNotificationDelivery {
    if (!Number.isInteger(policy.maxDetailedEntries) || policy.maxDetailedEntries < 0) {
      throw new RangeError("maxDetailedEntries must be a non-negative integer");
    }
    const queue = this.notifications.get(managerAgentId) ?? [];
    if (queue.length === 0) return { notifications: [] };
    this.notifications.delete(managerAgentId);
    const omittedCount = Math.max(0, queue.length - policy.maxDetailedEntries);
    const notifications = queue.slice(omittedCount);
    this.record({ type: "notifications-drained", managerAgentId, count: queue.length }, occurredAt);
    if (omittedCount === 0) return { notifications };
    const first = queue[0]!;
    const lastOmitted = queue[omittedCount - 1]!;
    return {
      notifications,
      summarized: {
        count: omittedCount,
        firstOccurredAt: first.occurredAt,
        lastOccurredAt: lastOmitted.occurredAt,
      },
    };
  }

  public events(): readonly FleetEvent[] {
    return [...this.eventHistory];
  }

  public toPersistenceDto(): FleetPersistenceDto {
    return {
      version: 1,
      sessions: this.list(),
      childAgents: this.listChildren(),
      blockingResults: [...this.blockingResults].map(([agentId, result]) => ({ agentId, result })),
      mailboxes: [...this.mailboxes].map(([managerAgentId, entries]) => ({ managerAgentId, entries: [...entries] })),
      deferredNotifications: [...this.notifications].map(([managerAgentId, entries]) => ({ managerAgentId, entries: [...entries] })),
      events: this.events(),
      nextNotificationId: this.nextNotificationId,
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
    for (const listener of this.listeners) listener(recorded);
  }
}
