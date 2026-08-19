/**
 * Reopening a conversation aboard started.
 *
 * Restore Fleet covers one case — the extension host restarted under a session
 * that was still live — and `review_pr` covers another, the session that owns
 * the pull request in flight. Neither covers the ordinary one: a brainstormer or
 * an interactive general-purpose the user finished with yesterday and now wants
 * back. That session left the fleet when its conversation ended, so nothing
 * offered it, and resuming it by hand loses the agent definition — `--resume`
 * restores an `--agent` selection by name, and aboard's names live in a
 * per-launch directory no bare `claude` is pointed at.
 *
 * This coordinator is the way back for all three: it merges what the fleet still
 * holds with what the session ledger remembers, checks each candidate against
 * the transcript on disk, and reopens the chosen one through the same
 * `planSessionResume` path the other two use.
 */

import type { InteractiveLaunchHandles, ReopenTarget } from "../bridge/delegation.js";
import type { AgentId, AgentType, SessionId, TerminalId } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import {
  reopenCandidates,
  type ReopenCandidate,
  type SessionLedgerDto,
} from "../domain/session-ledger.js";

/** Why a recorded session cannot be reopened, as the user is told it. */
export type UnresumableReason =
  /**
   * Claude Code holds no conversation under that id. Almost always its own
   * cleanup sweep: it deletes session files older than `cleanupPeriodDays` (30
   * by default) at every start, and aboard backs up the Manager's transcript
   * only. A conversation abandoned before its first exchange looks the same.
   */
  "no-transcript";

/** A candidate plus the answer to "would `--resume` actually find it?". */
export interface ReopenOption {
  readonly candidate: ReopenCandidate;
  readonly resumable: boolean;
  readonly reason?: UnresumableReason;
}

export type ReopenOutcome =
  | { readonly action: "none"; readonly reason: "no-recorded-sessions" | "no-match"; readonly selector?: string }
  | { readonly action: "focused"; readonly candidate: ReopenCandidate }
  | { readonly action: "reopened"; readonly candidate: ReopenCandidate; readonly handles: InteractiveLaunchHandles }
  | { readonly action: "unresumable"; readonly candidate: ReopenCandidate; readonly reason: UnresumableReason };

export interface ReopenLedgerSource {
  load(): Promise<SessionLedgerDto | undefined>;
}

export interface ReopenSessionLauncher {
  reopen(target: ReopenTarget): Promise<InteractiveLaunchHandles>;
}

export interface ReopenTerminals {
  isOpen(terminalId: TerminalId): boolean;
  /**
   * The agent's live terminal right now, if it has one. Asked again at reopen
   * time rather than trusted from the listing: the picker is open for as long as
   * the user takes over it, and a session that came back to life meanwhile must
   * be focused rather than launched a second time under the same identity.
   */
  liveTerminalFor(agentId: AgentId): TerminalId | undefined;
  show(terminalId: TerminalId): void;
}

export interface ReopenCoordinatorOptions {
  readonly ledger: ReopenLedgerSource;
  readonly fleet: FleetRegistry;
  readonly terminals: ReopenTerminals;
  readonly launcher: ReopenSessionLauncher;
  /**
   * Transcript test; the same one the Manager's resume and Restore Fleet use.
   * `cwd` is the directory the session ran in, which is where Claude Code filed
   * its transcript — absent for every session that ran in the workspace itself.
   */
  readonly isResumable: (sessionId: SessionId, cwd?: string) => Promise<boolean>;
}

/**
 * Matches `/reopen <selector>`: an agent id, or a type. Both spellings of the
 * brainstormer are accepted because the skill is `/brainstorm` while the agent
 * type is `brainstormer`, and a user who types either means the same thing.
 */
const TYPE_SELECTORS: Readonly<Record<string, AgentType>> = {
  brainstorm: "brainstormer",
  brainstormer: "brainstormer",
  "general-purpose": "general-purpose",
  "pr-doctor-hitl": "pr-doctor-hitl",
  implementer: "implementer",
};

export class ReopenCoordinator {
  public constructor(private readonly options: ReopenCoordinatorOptions) {}

  /**
   * Everything reopenable, newest first, each carrying whether Claude Code still
   * has its conversation. An unresumable candidate is kept rather than filtered:
   * a session the user remembers, silently missing from the list, tells them
   * nothing, while one that says its transcript was swept explains itself.
   *
   * The transcript checks run together — each stops at the first conversation
   * record, so they cost a few lines of JSONL apiece — and the list is bounded
   * by the ledger's own retention.
   */
  public async list(): Promise<readonly ReopenOption[]> {
    const ledger = await this.options.ledger.load().catch(() => undefined);
    const candidates = reopenCandidates(
      ledger,
      this.options.fleet.list(),
      (terminalId) => this.options.terminals.isOpen(terminalId),
    );
    return Promise.all(candidates.map(async (candidate): Promise<ReopenOption> => {
      // A live session needs no transcript test: its conversation is in front of
      // the user, and reopening it means focusing the terminal it is already in.
      if (candidate.origin === "live") return { candidate, resumable: true };
      const resumable = await this.options.isResumable(candidate.sessionId, candidate.cwd).catch(() => false);
      return resumable ? { candidate, resumable } : { candidate, resumable, reason: "no-transcript" };
    }));
  }

  /** Reopens one candidate: focus if it is live, relaunch through `--resume` otherwise. */
  public async reopen(candidate: ReopenCandidate): Promise<ReopenOutcome> {
    // Liveness is re-read rather than taken from the candidate: relaunching an
    // agent that already holds a terminal is refused downstream, and focusing is
    // what the user meant anyway.
    const live = this.options.terminals.liveTerminalFor(candidate.agentId);
    if (live !== undefined) {
      this.options.terminals.show(live);
      return { action: "focused", candidate };
    }
    if (!await this.options.isResumable(candidate.sessionId, candidate.cwd).catch(() => false)) {
      return { action: "unresumable", candidate, reason: "no-transcript" };
    }
    const handles = await this.options.launcher.reopen({
      agentId: candidate.agentId,
      type: candidate.type,
      sessionId: candidate.sessionId,
      terminalName: `aboard: ${candidate.description}`,
      ...(candidate.issueNumbers === undefined ? {} : { issueNumbers: candidate.issueNumbers }),
      ...(candidate.chromeEnabled === undefined ? {} : { chromeEnabled: candidate.chromeEnabled }),
      // Reopened where it ran: an auto-run's own checkout holds the transcript,
      // and the directory it names may no longer exist, which is what the
      // transcript test above has already settled.
      ...(candidate.cwd === undefined ? {} : { cwd: candidate.cwd }),
    });
    return { action: "reopened", candidate, handles };
  }

  /**
   * The `/reopen [selector]` path, which has no picker to offer: a hook blocks
   * the Manager's prompt while it runs, so waiting on a UI choice would burn the
   * hook's timeout and let the raw command through to the model. It resolves to
   * one session instead — the most recent resumable one, or the most recent
   * matching an agent id or type — which is predictable enough to type blind.
   */
  public async reopenLatest(selector?: string): Promise<ReopenOutcome> {
    const options = await this.list();
    if (options.length === 0) return { action: "none", reason: "no-recorded-sessions" };
    const wanted = selector?.trim().toLowerCase();
    const matching = wanted === undefined || wanted.length === 0
      ? options
      : options.filter(({ candidate }) =>
          candidate.agentId.toLowerCase() === wanted || TYPE_SELECTORS[wanted] === candidate.type);
    if (matching.length === 0) {
      return { action: "none", reason: "no-match", ...(selector === undefined ? {} : { selector }) };
    }
    // Prefer one that can actually be reopened, but fall back to the newest
    // match so the caller is told *why* it cannot rather than "no match".
    const chosen = matching.find((option) => option.resumable) ?? matching[0]!;
    return chosen.resumable
      ? this.reopen(chosen.candidate)
      : { action: "unresumable", candidate: chosen.candidate, reason: chosen.reason ?? "no-transcript" };
  }

  /** Looks one candidate up by agent id, for a tree item or a command argument. */
  public async find(agentId: AgentId): Promise<ReopenOption | undefined> {
    return (await this.list()).find((option) => option.candidate.agentId === agentId);
  }
}

/**
 * One wording for both callers — the palette command's notification and the
 * `/reopen` message the hook prints in place of the user's prompt. They describe
 * the same four outcomes, and two spellings would drift.
 */
export function describeReopenOutcome(outcome: ReopenOutcome): string {
  switch (outcome.action) {
    case "none":
      return outcome.reason === "no-recorded-sessions"
        ? "aboard has no recorded sessions to reopen."
        : `No recorded session matches ${outcome.selector ?? "that"}.`;
    case "focused":
      return `Focused the running ${outcome.candidate.type} terminal (agent ${outcome.candidate.agentId}).`;
    case "reopened":
      return `Reopened the ${outcome.candidate.type} session (agent ${outcome.candidate.agentId}) and handed it back to you.`;
    case "unresumable":
      return `Claude Code no longer has the conversation for agent ${outcome.candidate.agentId} (it deletes session files older than its cleanupPeriodDays setting), so it cannot be reopened.`;
  }
}
