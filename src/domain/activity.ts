/**
 * Recent activity: the bounded history of what aboard's agents and runs did.
 *
 * It replaces the narrow ended-session ledger. That file existed for exactly one
 * question — "how do I get back into that conversation?" — and answered nothing
 * about the automated work the user actually wants to see after stepping away.
 * A history the user can read is also what lets recovery stop depending on a
 * notification: a notification is a moment, and a moment is not a place to look.
 *
 * Only safe summary metadata is ever stored: identity, timing, issue and pull
 * request numbers, a short failure reason, and the launch facts a reopen has to
 * replay. Never prompts, transcripts, assistant messages, tokens, or
 * environments.
 */

import {
  isNonRestorablePersistedAgentType,
  type AgentId,
  type AgentSession,
  type AgentType,
  type IsoTimestamp,
  type SessionId,
  type TerminalId,
} from "./contracts.js";

/**
 * How many entries are kept. Claude Code sweeps its own transcripts older than
 * `cleanupPeriodDays`, so an unbounded history would mostly list conversations
 * that no longer exist to reopen; the cap keeps the view short and the file
 * small rather than trying to outlive the transcripts.
 */
export const ACTIVITY_LIMIT = 20;

/** The `aboard: ` prefix every terminal aboard creates carries. */
const TERMINAL_NAME_PREFIX = "aboard: ";

/**
 * How an agent's time in the fleet ended.
 *
 * `succeeded`/`failed`/`cancelled` describe an automated worker, whose result
 * went to a caller. `ended`/`killed`/`interrupted`/`launch-failed` describe a
 * session a human was in or would have been: the conversation finished, the
 * user killed it, the extension host went away under it, or Claude Code never
 * started at all.
 */
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

/**
 * Types a user can be handed back. The Manager is excluded because it has its
 * own lifecycle — `Resume Manager` resumes the recorded session and restores its
 * transcript backup — and reopening it from here would create a second Manager
 * record competing with that one. `webresearcher` and `Explore` are automated
 * only, with no conversation to hand over and no caller left to receive a
 * result.
 */
export function isReopenableType(type: AgentType): type is Exclude<AgentType, "manager"> {
  return type !== "manager" && !isNonRestorablePersistedAgentType(type);
}

/**
 * Whether a session leaving the fleet leaves a conversation behind.
 * `resultDelivery` decides it rather than the type: `general-purpose` runs
 * automated or handed off, and only the handed-off launch is a conversation the
 * user was part of and may want back.
 */
export function isReopenableSession(session: AgentSession): boolean {
  return session.resultDelivery.mode === "none" && isReopenableType(session.identity.type);
}

/** The description a terminal name carries, without aboard's own prefix. */
export function describeTerminalName(name: string): string {
  return name.startsWith(TERMINAL_NAME_PREFIX) ? name.slice(TERMINAL_NAME_PREFIX.length) : name;
}

/**
 * An agent's entry id. Keyed by agent and outcome rather than by timestamp, so
 * the same settlement observed twice — the terminal closing and the wrapper's
 * marker vanishing land within milliseconds of each other — refreshes one entry
 * instead of producing two.
 */
export function agentEntryId(agentId: AgentId, outcome: AgentOutcome): string {
  return `agent:${agentId}:${outcome}`;
}

/**
 * A run's entry id. `started`/`resumed` and the terminal outcome are separate
 * entries, and both are keyed by attempt: a resumed run keeps its run id, so
 * without the attempt a second attempt's start would overwrite the first's.
 */
export function runEntryId(runId: string, attempt: number, outcome: RunOutcome): string {
  return `run:${runId}:${attempt}:${outcome}`;
}

export function agentActivity(
  session: AgentSession,
  outcome: AgentOutcome,
  at: IsoTimestamp,
  options: { readonly reason?: string; readonly terminalId?: TerminalId } = {},
): AgentActivityEntry {
  const reopenable = isReopenableSession(session);
  return {
    kind: "agent",
    id: agentEntryId(session.identity.agentId, outcome),
    at,
    agentId: session.identity.agentId,
    type: session.identity.type,
    description: describeTerminalName(session.terminal.name),
    outcome,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
    ...(options.terminalId === undefined ? {} : { terminalId: options.terminalId }),
    ...(reopenable
      ? {
          reopen: {
            sessionId: session.sessionId,
            ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
            ...(session.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
            ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
            ...(session.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
          },
        }
      : {}),
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
  },
): RunActivityEntry {
  return {
    kind: "run",
    id: runEntryId(input.runId, input.attempt, input.outcome),
    at: input.at,
    runId: input.runId,
    attempt: input.attempt,
    outcome: input.outcome,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.issueNumbers === undefined ? {} : { issueNumbers: input.issueNumbers }),
    ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
  };
}

/**
 * Appends an entry, newest first, capped. Idempotent by id: activation
 * reconciliation runs on every window reload and must not turn one interrupted
 * session into a growing pile of identical rows.
 */
export function appendActivity(
  store: ActivityDto | undefined,
  entry: ActivityEntry,
  limit: number = ACTIVITY_LIMIT,
): ActivityDto {
  const previous = (store ?? EMPTY_ACTIVITY).entries.filter((existing) => existing.id !== entry.id);
  return { version: 1, entries: [entry, ...previous].slice(0, Math.max(limit, 0)) };
}

/** True when clearing the store would cost the user a way back into a conversation. */
export function hasReopenableEntries(store: ActivityDto | undefined): boolean {
  return (store ?? EMPTY_ACTIVITY).entries.some((entry) => entry.kind === "agent" && entry.reopen !== undefined);
}

/**
 * One legacy `sessions.json` record, as the migration reads it. Deliberately
 * structural rather than an import of the removed ledger types: this exists to
 * drain a file that will not be written again.
 */
export interface LegacySessionRecord {
  readonly agentId: AgentId;
  readonly type: AgentType;
  readonly sessionId: SessionId;
  readonly description: string;
  readonly endedAt: IsoTimestamp;
  readonly issueNumbers?: readonly number[];
  readonly chromeEnabled?: true;
  readonly cwd?: string;
  readonly autoRunRestricted?: true;
}

/**
 * Folds the old ledger into the activity store, once. An entry already present
 * for the same agent wins: it was written by this version and knows the real
 * outcome, while the ledger only ever recorded "ended".
 */
export function migrateLegacySessions(
  store: ActivityDto | undefined,
  sessions: readonly LegacySessionRecord[],
  limit: number = ACTIVITY_LIMIT,
): ActivityDto {
  let result = store ?? EMPTY_ACTIVITY;
  const known = new Set(result.entries.flatMap((entry) => (entry.kind === "agent" ? [entry.agentId] : [])));
  // Oldest first, so the newest legacy record ends up at the top after each
  // append pushes the previous one down.
  const ordered = [...sessions].sort((left, right) => left.endedAt.localeCompare(right.endedAt));
  for (const session of ordered) {
    if (known.has(session.agentId) || !isReopenableType(session.type)) continue;
    known.add(session.agentId);
    result = appendActivity(result, {
      kind: "agent",
      id: agentEntryId(session.agentId, "ended"),
      at: session.endedAt,
      agentId: session.agentId,
      type: session.type,
      description: session.description,
      outcome: "ended",
      ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
      reopen: {
        sessionId: session.sessionId,
        ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
        ...(session.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        ...(session.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
      },
    }, limit);
  }
  return result;
}

export type ReopenOrigin =
  /** Still running with an open terminal: reopening means focusing it. */
  | "live"
  /** Gone from the fleet; the activity store is the only record it existed. */
  | "ended";

export interface ReopenCandidate {
  readonly agentId: AgentId;
  readonly type: Exclude<AgentType, "manager">;
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

/**
 * Everything the user could ask to be taken back to, newest first.
 *
 * Two sources, because "I closed it yesterday" and "it is running right now"
 * are the same wish and should not be two commands: the activity store supplies
 * sessions the fleet has already forgotten, and the fleet supplies the ones it
 * still holds. The fleet wins a collision — it is the live record, and an
 * activity entry for an agent that is running again is stale by definition.
 */
export function reopenCandidates(
  store: ActivityDto | undefined,
  fleetSessions: readonly AgentSession[],
  isTerminalOpen: (terminalId: TerminalId) => boolean,
): readonly ReopenCandidate[] {
  const candidates = new Map<AgentId, ReopenCandidate>();
  for (const session of fleetSessions) {
    const type = session.identity.type;
    if (!isReopenableSession(session) || !isReopenableType(type)) continue;
    // Only a session with a terminal the user can be sent to counts as live.
    // Agents whose terminal is gone are reconciled into activity at activation,
    // so they reach this list through the store instead.
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

/**
 * How a row reads. Role-aware rather than a lifecycle name: "review finished"
 * and "conversation ended" are the same internal state and different events to
 * a person.
 */
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
