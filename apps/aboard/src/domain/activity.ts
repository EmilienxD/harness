
import {

  isNonRestorablePersistedAgentType,
  type AgentId,
  type AgentSession,
  type AgentType,
  type IsoTimestamp,
  type SessionId,
  type TerminalId,
} from "./contracts.js";

export const ACTIVITY_LIMIT = 20;

/** The `aboard: ` prefix every terminal aboard creates carries. */
const TERMINAL_NAME_PREFIX = "aboard: ";

export type AgentOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "ended"
  | "killed"
  | "launch-failed"
  | "interrupted";

export type RunOutcome =
  | "started"
  | "resumed"
  | "succeeded"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "discarded";

/** The launch facts a reopen replays. No prompt text, no conversation content. */
export interface ReopenableSession {
  readonly sessionId: SessionId;
  readonly issueNumbers?: readonly number[];
  readonly chromeEnabled?: true;
  /** Where the session ran, when that was not the workspace root. */
  readonly cwd?: string;
  /** Replays auto-run's git/GitHub command fence when this conversation reopens. */
  readonly autoRunRestricted?: true;
}

export interface AgentActivityEntry {
  readonly kind: "agent";
  /** Stable within the store, so appends can be idempotent. */
  readonly id: string;
  readonly at: IsoTimestamp;
  readonly agentId: AgentId;
  readonly type: AgentType;
  /** The launch description, as shown on the terminal. */
  readonly description: string;
  readonly outcome: AgentOutcome;
  /** Wall-clock launch duration. Summary metadata only; no conversation telemetry. */
  readonly durationMs?: number;
  /** Short and human-readable; the stack stays in the output channel. */
  readonly reason?: string;
  readonly issueNumbers?: readonly number[];
  readonly pullRequest?: number;
  /** Present while the terminal may still be open, so the row can focus it. */
  readonly terminalId?: TerminalId;
  /** Present only when this conversation can be handed back to the user. */
  readonly reopen?: ReopenableSession;

}

export interface RunActivityEntry {
  readonly kind: "run";
  readonly id: string;
  readonly at: IsoTimestamp;
  readonly runId: string;
  readonly attempt: number;
  readonly outcome: RunOutcome;
  /** Duration of this attempt, derived from its recorded start or resume row. */
  readonly durationMs?: number;
  readonly completedIssues?: number;
  readonly totalIssues?: number;
  readonly currentIssue?: number;
  readonly reason?: string;
  /** The plan's issue numbers, so the row can say what the run was for. */
  readonly issueNumbers?: readonly number[];
  readonly pullRequest?: number;
}

export type ActivityEntry = AgentActivityEntry | RunActivityEntry;

export interface ActivityDto {
  readonly version: 1;
  readonly entries: readonly ActivityEntry[];
}

export const EMPTY_ACTIVITY: ActivityDto = { version: 1, entries: [] };

export function isReopenableType(type: AgentType): boolean {
  return !isNonRestorablePersistedAgentType(type);
}

/** The original launch was handed to the user; reporting is an independent axis. */
export function isInteractiveLaunch(session: AgentSession): boolean {
  return session.attended === true && isReopenableType(session.identity.type);
}

/** Claude can hand this conversation back to the user after its original caller is gone. */
export function canReopenSession(session: AgentSession): boolean {
  return isReopenableType(session.identity.type);
}

/** Empty interactive launches are neither conversations to reopen nor outcomes worth retaining. */
export function shouldRecordEndedSession(session: AgentSession, conversationStarted: boolean): boolean {
  return !isInteractiveLaunch(session) || conversationStarted;
}

/** The description a terminal name carries, without aboard's own prefix. */
export function describeTerminalName(name: string): string {
  return name.startsWith(TERMINAL_NAME_PREFIX) ? name.slice(TERMINAL_NAME_PREFIX.length) : name;
}

export function agentEntryId(agentId: AgentId, outcome: AgentOutcome): string {
  return `agent:${agentId}:${outcome}`;
}

export function runEntryId(runId: string, attempt: number, outcome: RunOutcome): string {
  return `run:${runId}:${attempt}:${outcome}`;
}

export function agentActivity(
  session: AgentSession,
  outcome: AgentOutcome,
  at: IsoTimestamp,
  options: { readonly reason?: string; readonly terminalId?: TerminalId } = {},
): AgentActivityEntry {
  const reopenable = canReopenSession(session);

  const durationMs = elapsedMs(session.lifecycle.startedAt, at);
  const launchFacts: ReopenableSession = {
    sessionId: session.sessionId,
    ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
    ...(session.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
  };
  return {
    kind: "agent",
    id: agentEntryId(session.identity.agentId, outcome),
    at,
    agentId: session.identity.agentId,
    type: session.identity.type,
    description: describeTerminalName(session.terminal.name),
    outcome,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
    ...(options.terminalId === undefined ? {} : { terminalId: options.terminalId }),
    ...(reopenable ? { reopen: launchFacts } : {}),
  };
}

export function runActivity(
  input: {
    readonly runId: string;
    readonly attempt: number;
    readonly outcome: RunOutcome;
    readonly at: IsoTimestamp;
    readonly reason?: string;
    readonly issueNumbers?: readonly number[];
    readonly pullRequest?: number;
    readonly durationMs?: number;
    readonly completedIssues?: number;
    readonly totalIssues?: number;
    readonly currentIssue?: number;
  },
): RunActivityEntry {
  return {
    kind: "run",
    id: runEntryId(input.runId, input.attempt, input.outcome),
    at: input.at,
    runId: input.runId,
    attempt: input.attempt,
    outcome: input.outcome,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.completedIssues === undefined ? {} : { completedIssues: input.completedIssues }),
    ...(input.totalIssues === undefined ? {} : { totalIssues: input.totalIssues }),
    ...(input.currentIssue === undefined ? {} : { currentIssue: input.currentIssue }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.issueNumbers === undefined ? {} : { issueNumbers: input.issueNumbers }),
    ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
  };
}

export function appendActivity(
  store: ActivityDto | undefined,
  entry: ActivityEntry,
  limit: number = ACTIVITY_LIMIT,
): ActivityDto {
  const previous = (store ?? EMPTY_ACTIVITY).entries.filter((existing) => {
    if (existing.id === entry.id) return false;
    // A run attempt is one useful history item. Its final outcome replaces the
    // temporary start/resume marker instead of spending two of the twenty slots.
    if (
      entry.kind === "run" && existing.kind === "run"
      && entry.runId === existing.runId && entry.attempt === existing.attempt
      && entry.outcome !== "started" && entry.outcome !== "resumed"
      && (existing.outcome === "started" || existing.outcome === "resumed")
    ) return false;
    return true;
  });
  return { version: 1, entries: [entry, ...previous].slice(0, Math.max(limit, 0)) };
}

function elapsedMs(startedAt: IsoTimestamp, endedAt: IsoTimestamp): number | undefined {
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

/** True when clearing the store would cost the user a way back into a conversation. */
export function hasReopenableEntries(store: ActivityDto | undefined): boolean {
  return (store ?? EMPTY_ACTIVITY).entries.some((entry) => entry.kind === "agent" && entry.reopen !== undefined);
}


export type ReopenOrigin =
  /** Still running with an open terminal: reopening means focusing it. */
  | "live"
  /** Gone from the fleet; the activity store is the only record it existed. */
  | "ended";

export interface ReopenCandidate {
  readonly agentId: AgentId;
  readonly type: AgentType;
  readonly sessionId: SessionId;
  readonly description: string;
  readonly origin: ReopenOrigin;
  /** When this session last mattered: its end, or its start while it still runs. */
  readonly at: IsoTimestamp;
  /** Present only for a live candidate, which is focused rather than relaunched. */
  readonly terminalId?: TerminalId;
  readonly issueNumbers?: readonly number[];
  readonly chromeEnabled?: boolean;
  /** Where the session ran; absent means the workspace root. */
  readonly cwd?: string;
  readonly autoRunRestricted?: true;
}

export function reopenCandidates(
  store: ActivityDto | undefined,
  fleetSessions: readonly AgentSession[],
  isTerminalOpen: (terminalId: TerminalId) => boolean,
): readonly ReopenCandidate[] {
  const candidates = new Map<AgentId, ReopenCandidate>();
  for (const session of fleetSessions) {
    const type = session.identity.type;
    if (!canReopenSession(session) || !isReopenableType(type)) continue;
    if (!isTerminalOpen(session.terminal.terminalId)) continue;
    candidates.set(session.identity.agentId, {
      agentId: session.identity.agentId,
      type,
      sessionId: session.sessionId,
      description: describeTerminalName(session.terminal.name),
      origin: "live",
      at: session.lifecycle.startedAt,
      terminalId: session.terminal.terminalId,
      ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
      ...(session.chromeEnabled === true ? { chromeEnabled: true } : {}),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
    });
  }
  for (const entry of (store ?? EMPTY_ACTIVITY).entries) {
    if (entry.kind !== "agent" || entry.reopen === undefined) continue;
    // Defensive rather than redundant: the file survives upgrades, so a type
    // this version will not reopen may still be in it.
    if (!isReopenableType(entry.type) || candidates.has(entry.agentId)) continue;
    candidates.set(entry.agentId, {
      agentId: entry.agentId,
      type: entry.type,
      sessionId: entry.reopen.sessionId,
      description: entry.description,
      origin: "ended",
      at: entry.at,
      ...(entry.reopen.issueNumbers === undefined ? {} : { issueNumbers: entry.reopen.issueNumbers }),
      ...(entry.reopen.chromeEnabled === true ? { chromeEnabled: true } : {}),
      ...(entry.reopen.cwd === undefined ? {} : { cwd: entry.reopen.cwd }),
      ...(entry.reopen.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
    });
  }
  return [...candidates.values()].sort((left, right) => right.at.localeCompare(left.at));
}

export function describeActivity(entry: ActivityEntry): string {
  if (entry.kind === "run") {
    switch (entry.outcome) {
      case "started": return "auto-run started";
      case "resumed": return `auto-run resumed (attempt ${entry.attempt})`;
      case "succeeded": return "auto-run finished";
      case "cancelled": return "auto-run stopped by you";
      case "interrupted": return "auto-run interrupted";
      case "failed": return "auto-run failed";
      case "discarded": return "auto-run discarded";
    }
  }
  switch (entry.outcome) {
    case "succeeded": return `${entry.type} finished`;
    case "failed": return `${entry.type} failed`;
    case "cancelled": return `${entry.type} cancelled`;
    case "ended": return `${entry.type} conversation ended`;
    case "killed": return `${entry.type} terminal closed`;
    case "launch-failed": return `${entry.type} could not start`;
    case "interrupted": return `${entry.type} interrupted`;
  }
}
