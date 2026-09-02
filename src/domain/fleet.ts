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
      readonly recipientAgentId: AgentId;
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
  readonly kind: "result";
  readonly agentId: AgentId;
  readonly agentType: AgentSession["identity"]["type"];
  readonly result: WorkerResult;
}

export interface EndedWithoutReportEntry {
  readonly kind: "ended-without-report";
  readonly agentId: AgentId;
  readonly agentType: AgentSession["identity"]["type"];
}

export type ReportEntry = MailboxEntry | EndedWithoutReportEntry;

export const MAX_QUEUED_REPORTS = 20;
export const MAX_QUEUED_REPORT_CHARACTERS = 9_500;
export const MAX_FLEET_EVENTS = 100;
export const MAX_DEFERRED_NOTIFICATIONS = 20;

export interface FleetPersistenceDto {
  readonly version: 1;
  readonly sessions: readonly AgentSession[];
  readonly childAgents?: readonly ChildAgentNode[];
  readonly blockingResults: readonly { readonly agentId: AgentId; readonly result: WorkerResult }[];
  readonly mailboxes: readonly {
    readonly recipientAgentId: AgentId;
    readonly entries: readonly ReportEntry[];
  }[];
  readonly deferredNotifications: readonly {
    readonly recipientAgentId: AgentId;
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
  private readonly mailboxes = new Map<AgentId, ReportEntry[]>();
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
      for (const entry of mailbox.entries) registry.#enqueueReport(mailbox.recipientAgentId, entry);
    }
    for (const queue of dto.deferredNotifications) {
      registry.notifications.set(queue.recipientAgentId, [...queue.entries]);
    }
    registry.eventHistory.push(...dto.events.slice(-MAX_FLEET_EVENTS));
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
      const recipient = this.sessionsByAgent.get(session.resultDelivery.recipientAgentId);
      if (recipient === undefined) {
        throw new FleetStateError(
          "unknown-agent",
          `Report recipient ${session.resultDelivery.recipientAgentId} is not registered`,
        );
      }
    }
    this.sessionsByAgent.set(agentId, session);
    this.agentBySession.set(session.sessionId, agentId);
    this.record({ type: "agent-registered", agentId, sessionId: session.sessionId }, occurredAt);
  }

  public remove(agentId: AgentId, occurredAt: IsoTimestamp): void {
    const session = this.sessionsByAgent.get(agentId);
    if (session === undefined) return;
    if (session.resultDelivery.mode === "mailbox" && session.lastResult === undefined) {
      this.#enqueueReport(session.resultDelivery.recipientAgentId, {
        kind: "ended-without-report",
        agentId,
        agentType: session.identity.type,
      });
    }
    this.sessionsByAgent.delete(agentId);
    this.agentBySession.delete(session.sessionId);
    this.blockingResults.delete(agentId);
    this.notifications.delete(agentId);
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

  /** Live sessions that still owe this recipient a report, in fleet order. */
  public reportsOwedTo(recipientAgentId: AgentId): readonly AgentSession[] {
    return this.list().filter((session) =>
      session.resultDelivery.mode === "mailbox"
      && session.resultDelivery.recipientAgentId === recipientAgentId
      && session.lastResult === undefined
      && (session.lifecycle.status === "starting" || session.lifecycle.status === "running" || session.lifecycle.status === "awaiting-user"));
  }

  /** Complete an attended session with the explicit report supplied by `/done`. */
  public submitReport(agentId: AgentId, message: string, occurredAt: IsoTimestamp): WorkerResult {
    if (message.trim().length === 0) throw new FleetStateError("invalid-result", "Report must not be empty");
    const session = this.requireSession(agentId);
    if (session.resultDelivery.mode === "none") {
      throw new FleetStateError("invalid-result", `Agent ${agentId} has no result delivery route`);
    }
    if (session.lifecycle.status !== "starting" && session.lifecycle.status !== "running" && session.lifecycle.status !== "awaiting-user") {
      throw new FleetStateError("invalid-result", `Agent ${agentId} has already ended`);
    }
    const result: WorkerResult = {
      outcome: "succeeded",
      exitCode: 0,
      lastAssistantMessage: message,
      telemetry: session.telemetry,
    };
    this.transition(agentId, {
      status: "completed",
      startedAt: session.lifecycle.startedAt,
      finishedAt: occurredAt,
      exitCode: 0,
      lastAssistantMessage: message,
    }, occurredAt);
    this.recordResult(agentId, result, occurredAt);
    return result;
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
        this.#enqueueReport(session.resultDelivery.recipientAgentId, {
          kind: "result",
          agentId,
          agentType: session.identity.type,
          result,
        });
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

  public drainMailbox(recipientAgentId: AgentId, occurredAt: IsoTimestamp): readonly ReportEntry[] {
    const entries = this.mailboxes.get(recipientAgentId) ?? [];
    if (entries.length === 0) return [];
    this.mailboxes.delete(recipientAgentId);
    for (const entry of entries) {
      this.record({ type: "result-drained", agentId: entry.agentId, delivery: "mailbox" }, occurredAt);
    }
    return entries;
  }

  public enqueueNotification(recipientAgentId: AgentId, message: string, occurredAt: IsoTimestamp): void {
    if (message.trim().length === 0) {
      throw new FleetStateError("invalid-result", "Deferred notification must not be empty");
    }
    this.requireSession(recipientAgentId);
    const queue = this.notifications.get(recipientAgentId) ?? [];
    queue.push({ id: this.nextNotificationId++, occurredAt, message });
    while (queue.length > MAX_DEFERRED_NOTIFICATIONS) queue.shift();
    this.notifications.set(recipientAgentId, queue);
    this.record({ type: "notification-enqueued", recipientAgentId, count: 1 }, occurredAt);
  }

  public drainNotifications(
    recipientAgentId: AgentId,
    occurredAt: IsoTimestamp,
    policy: NotificationSummaryPolicy = DEFAULT_NOTIFICATION_SUMMARY_POLICY,
  ): DeferredNotificationDelivery {
    if (!Number.isInteger(policy.maxDetailedEntries) || policy.maxDetailedEntries < 0) {
      throw new RangeError("maxDetailedEntries must be a non-negative integer");
    }
    const queue = this.notifications.get(recipientAgentId) ?? [];
    if (queue.length === 0) return { notifications: [] };
    this.notifications.delete(recipientAgentId);
    const omittedCount = Math.max(0, queue.length - policy.maxDetailedEntries);
    const notifications = queue.slice(omittedCount);
    this.record({ type: "notifications-drained", recipientAgentId, count: queue.length }, occurredAt);
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

  /** Monotonic change token used to close the check-then-subscribe long-poll race. */
  public revision(): number {
    return this.nextEventSequence - 1;
  }

  public toPersistenceDto(): FleetPersistenceDto {
    return {
      version: 1,
      sessions: this.list(),
      childAgents: this.listChildren(),
      blockingResults: [...this.blockingResults].map(([agentId, result]) => ({ agentId, result })),
      mailboxes: [...this.mailboxes].map(([recipientAgentId, entries]) => ({ recipientAgentId, entries: [...entries] })),
      deferredNotifications: [...this.notifications].map(([recipientAgentId, entries]) => ({ recipientAgentId, entries: [...entries] })),
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

  #enqueueReport(recipientAgentId: AgentId, entry: ReportEntry): void {
    const normalized = boundReportEntry(entry, MAX_QUEUED_REPORT_CHARACTERS);
    const entries = [...(this.mailboxes.get(recipientAgentId) ?? []), normalized];
    while (entries.length > MAX_QUEUED_REPORTS || reportCharacters(entries) > MAX_QUEUED_REPORT_CHARACTERS) entries.shift();
    this.mailboxes.set(recipientAgentId, entries);
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

function reportCharacters(entries: readonly ReportEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.kind === "result"
    ? entry.result.outcome === "succeeded"
      ? entry.result.lastAssistantMessage.length
      : entry.result.failure.lastAssistantMessage?.length ?? 0
    : entry.agentId.length + entry.agentType.length), 0);
}

function boundReportEntry(entry: ReportEntry, maxCharacters: number): ReportEntry {
  if (entry.kind === "ended-without-report") return entry;
  if (entry.result.outcome === "succeeded") {
    return {
      ...entry,
      result: { ...entry.result, lastAssistantMessage: entry.result.lastAssistantMessage.slice(0, maxCharacters) },
    };
  }
  const message = entry.result.failure.lastAssistantMessage;
  return message === null
    ? entry
    : { ...entry, result: { ...entry.result, failure: { ...entry.result.failure, lastAssistantMessage: message.slice(0, maxCharacters) } } };
}
