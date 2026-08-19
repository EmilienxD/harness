/**
 * The record of aboard sessions that are over.
 *
 * A handed-off session — a brainstormer, an interactive general-purpose, a
 * pr-doctor-hitl — reports no result, so when its conversation ends the fleet
 * simply removes it (`AGENTS.md`: only result-delivering workers stay listed).
 * That is right for the fleet, which describes what is *current*, and wrong for
 * the user, who then has no way back into a conversation they were in the
 * middle of: the agent id, the session id, and the type all disappear together.
 *
 * Without them a resume is impossible rather than merely inconvenient. An aboard
 * agent runs from a definition rewritten per launch into
 * `.aboard/runtime/agents/<agentId>/`, registered under `aboard-<type>-<agentId>`
 * and selected with `--agent`; `--resume` restores that selection *by name*, so a
 * hand-run `claude --resume <id>` finds no such name and silently continues on
 * Claude Code's default persona holding every default tool. Reopening correctly
 * means re-emitting the definition and re-passing its flags, which
 * `planSessionResume` already does — given the identity this ledger keeps.
 *
 * Only the non-derivable join is stored. The runtime directories name agent ids
 * and types but no session id, and general-purpose writes no definition at all;
 * the transcript directory names session ids but no agent. Neither side can
 * reconstruct the other, so this file holds exactly that pairing and the launch
 * facts a resume must replay (issues, Chrome intent) — no prompt text, no
 * conversation content.
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
 * How many ended sessions are kept. Claude Code sweeps its own transcripts older
 * than `cleanupPeriodDays` (30 by default), so an unbounded ledger would mostly
 * list conversations that no longer exist to resume; the cap keeps the picker
 * short and the file small rather than trying to outlive the transcripts.
 */
export const DEFAULT_SESSION_LEDGER_LIMIT = 20;

/** The `aboard: ` prefix every terminal aboard creates carries. */
const TERMINAL_NAME_PREFIX = "aboard: ";

export interface EndedSessionRecord {
  readonly agentId: AgentId;
  readonly type: AgentType;
  readonly sessionId: SessionId;
  /** The launch description, as shown on the terminal and in the picker. */
  readonly description: string;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly issueNumbers?: readonly number[];
  readonly chromeEnabled?: true;
  /**
   * Where the session ran, when that was not the workspace root. Part of the
   * non-derivable join this ledger exists for: the transcript lives under this
   * directory, and an auto-run's own checkout is gone by the time anyone asks.
   */
  readonly cwd?: string;
}

export interface SessionLedgerDto {
  readonly version: 1;
  readonly sessions: readonly EndedSessionRecord[];
}

export const EMPTY_SESSION_LEDGER: SessionLedgerDto = { version: 1, sessions: [] };

/**
 * Types a user can be handed back. The Manager is excluded because it has its
 * own lifecycle — `Resume Manager` resumes the recorded session and restores its
 * transcript backup — and reopening it from here would create a second Manager
 * record competing with that one. `webresearcher` and `Explore` are excluded for
 * the reason they are excluded from Restore Fleet: they are automated-only, with
 * no conversation to hand over and no caller left to receive a result.
 */
export function isReopenableType(type: AgentType): type is Exclude<AgentType, "manager"> {
  return type !== "manager" && !isNonRestorablePersistedAgentType(type);
}

/**
 * Whether a session leaving the fleet is worth remembering. `resultDelivery`
 * decides it rather than the type: `general-purpose` runs automated or handed
 * off, and only the handed-off launch is a conversation the user was part of and
 * may want back. An automated launch's result already went to its caller.
 */
export function isLedgerRecordable(session: AgentSession): boolean {
  return session.resultDelivery.mode === "none" && isReopenableType(session.identity.type);
}

/** The description a terminal name carries, without aboard's own prefix. */
export function describeTerminalName(name: string): string {
  return name.startsWith(TERMINAL_NAME_PREFIX) ? name.slice(TERMINAL_NAME_PREFIX.length) : name;
}

export function endedSessionFrom(session: AgentSession, endedAt: IsoTimestamp): EndedSessionRecord {
  return {
    agentId: session.identity.agentId,
    type: session.identity.type,
    sessionId: session.sessionId,
    description: describeTerminalName(session.terminal.name),
    startedAt: session.lifecycle.startedAt,
    endedAt,
    ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
    ...(session.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
  };
}

/**
 * Appends an ended session, newest first. An agent that was reopened and ended
 * again replaces its earlier entry rather than appearing twice: the pair is the
 * same conversation, and the later ending is the true one.
 */
export function recordEndedSession(
  ledger: SessionLedgerDto | undefined,
  entry: EndedSessionRecord,
  limit: number = DEFAULT_SESSION_LEDGER_LIMIT,
): SessionLedgerDto {
  const previous = (ledger ?? EMPTY_SESSION_LEDGER).sessions.filter(
    (session) => session.agentId !== entry.agentId,
  );
  return { version: 1, sessions: [entry, ...previous].slice(0, Math.max(limit, 0)) };
}

export type ReopenOrigin =
  /** Still running with an open terminal: reopening means focusing it. */
  | "live"
  /** In the fleet with no terminal — the extension host restarted under it. */
  | "paused"
  /** Gone from the fleet; the ledger is the only record it existed. */
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
}

/**
 * Everything the user could ask to be taken back to, newest first.
 *
 * Two sources, because "I closed it yesterday" and "VS Code restarted under it"
 * are the same wish and should not be two commands: the ledger supplies sessions
 * the fleet has already forgotten, and the fleet supplies the ones it still
 * holds. The fleet wins a collision — it is the live record, and the ledger
 * entry for an agent that is running again is stale by definition.
 */
export function reopenCandidates(
  ledger: SessionLedgerDto | undefined,
  fleetSessions: readonly AgentSession[],
  isTerminalOpen: (terminalId: TerminalId) => boolean,
): readonly ReopenCandidate[] {
  const candidates = new Map<AgentId, ReopenCandidate>();
  for (const session of fleetSessions) {
    const type = session.identity.type;
    if (!isLedgerRecordable(session) || !isReopenableType(type)) continue;
    const open = isTerminalOpen(session.terminal.terminalId);
    candidates.set(session.identity.agentId, {
      agentId: session.identity.agentId,
      type,
      sessionId: session.sessionId,
      description: describeTerminalName(session.terminal.name),
      origin: open ? "live" : "paused",
      at: session.lifecycle.startedAt,
      ...(open ? { terminalId: session.terminal.terminalId } : {}),
      ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
      ...(session.chromeEnabled === true ? { chromeEnabled: true } : {}),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    });
  }
  for (const entry of (ledger ?? EMPTY_SESSION_LEDGER).sessions) {
    // Defensive rather than redundant: the file is user-visible and survives
    // upgrades, so a type this version will not reopen may still be in it.
    if (!isReopenableType(entry.type) || candidates.has(entry.agentId)) continue;
    candidates.set(entry.agentId, {
      agentId: entry.agentId,
      type: entry.type,
      sessionId: entry.sessionId,
      description: entry.description,
      origin: "ended",
      at: entry.endedAt,
      ...(entry.issueNumbers === undefined ? {} : { issueNumbers: entry.issueNumbers }),
      ...(entry.chromeEnabled === true ? { chromeEnabled: true } : {}),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    });
  }
  return [...candidates.values()].sort((left, right) => right.at.localeCompare(left.at));
}
