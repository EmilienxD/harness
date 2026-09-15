
import type { InteractiveLaunchHandles, ReopenTarget } from "../bridge/delegation.js";
import type { AgentId, AgentPlatformId, AgentType, SessionId, TerminalId } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import {
  reopenCandidates,
  type ActivityDto,
  type ReopenCandidate,
} from "../domain/activity.js";

/** Why a recorded session cannot be reopened, as the user is told it. */
export type UnresumableReason =
  "no-transcript" | "inspection-failed";

/** A candidate plus the answer to "would `--resume` actually find it?". */
export interface ReopenOption {
  readonly candidate: ReopenCandidate;
  readonly resumable: boolean;
  readonly reason?: UnresumableReason;
  readonly diagnostic?: string;
}


export type ReopenOutcome =
  | { readonly action: "none"; readonly reason: "no-recorded-sessions" | "no-match"; readonly selector?: string }
  | { readonly action: "focused"; readonly candidate: ReopenCandidate }
  | { readonly action: "reopened"; readonly candidate: ReopenCandidate; readonly handles: InteractiveLaunchHandles }
  | { readonly action: "unresumable"; readonly candidate: ReopenCandidate; readonly reason: UnresumableReason; readonly diagnostic?: string };

export interface ReopenActivitySource {
  entries(): ActivityDto;
}

export interface ReopenSessionLauncher {
  reopen(target: ReopenTarget): Promise<InteractiveLaunchHandles>;
}


export interface ReopenTerminals {
  isOpen(terminalId: TerminalId): boolean;
  liveTerminalFor(agentId: AgentId): TerminalId | undefined;
  show(terminalId: TerminalId): void;
}

export interface ReopenCoordinatorOptions {
  readonly activity: ReopenActivitySource;
  readonly fleet: FleetRegistry;
  readonly terminals: ReopenTerminals;
  readonly launcher: ReopenSessionLauncher;
  readonly isResumable: (platform: AgentPlatformId, sessionId: SessionId, cwd?: string, type?: AgentType) => Promise<boolean>;
}

const TYPE_SELECTORS: Readonly<Record<string, AgentType>> = {
  interactive: "interactive",
  explore: "Explore",
  implementer: "implementer",
  reviewer: "reviewer",
};

export class ReopenCoordinator {
  public constructor(private readonly options: ReopenCoordinatorOptions) {}

  public async list(): Promise<readonly ReopenOption[]> {
    const candidates = reopenCandidates(
      this.options.activity.entries(),
      this.options.fleet.list(),
      (terminalId) => this.options.terminals.isOpen(terminalId),
    );
    return Promise.all(candidates.map(async (candidate): Promise<ReopenOption> => {
      // A live session needs no transcript test: its conversation is in front of
      // the user, and reopening it means focusing the terminal it is already in.
      if (candidate.origin === "live") return { candidate, resumable: true };
      try {
        const resumable = await this.options.isResumable(candidate.platform, candidate.sessionId, candidate.cwd, candidate.type);
        return resumable ? { candidate, resumable } : { candidate, resumable, reason: "no-transcript" };
      } catch (error) {
        return {
          candidate,
          resumable: false,
          reason: "inspection-failed",
          diagnostic: error instanceof Error ? error.message : "The selected agent platform could not inspect the conversation",
        };
      }
    }));
  }

  /** Reopens one candidate: focus if it is live, relaunch through `--resume` otherwise. */
  public async reopen(candidate: ReopenCandidate): Promise<ReopenOutcome> {
    const live = this.options.terminals.liveTerminalFor(candidate.agentId);
    if (live !== undefined) {
      this.options.terminals.show(live);
      return { action: "focused", candidate };
    }

    let resumable: boolean;
    try {
      resumable = await this.options.isResumable(candidate.platform, candidate.sessionId, candidate.cwd, candidate.type);
    } catch (error) {
      // A platform that cannot inspect the conversation has not told us the
      // conversation is gone; say which of the two happened.
      return {
        action: "unresumable",
        candidate,
        reason: "inspection-failed",
        diagnostic: error instanceof Error ? error.message : "The selected agent platform could not inspect the conversation",
      };
    }
    if (!resumable) return { action: "unresumable", candidate, reason: "no-transcript" };
    const handles = await this.options.launcher.reopen({
      platform: candidate.platform,
      agentId: candidate.agentId,
      type: candidate.type,
      sessionId: candidate.sessionId,
      terminalName: `aboard: ${candidate.description}`,
      ...(candidate.issueNumbers === undefined ? {} : { issueNumbers: candidate.issueNumbers }),
      ...(candidate.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
      ...(candidate.cwd === undefined ? {} : { cwd: candidate.cwd }),
      ...(candidate.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
    });
    return { action: "reopened", candidate, handles };
  }

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
      : {
          action: "unresumable",
          candidate: chosen.candidate,
          reason: chosen.reason ?? "no-transcript",
          ...(chosen.diagnostic === undefined ? {} : { diagnostic: chosen.diagnostic }),
        };
  }

  /** Looks one candidate up by agent id, for a tree item or a command argument. */
  public async find(agentId: AgentId): Promise<ReopenOption | undefined> {
    return (await this.list()).find((option) => option.candidate.agentId === agentId);
  }

}

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
      return outcome.reason === "inspection-failed"
        ? `The conversation for agent ${outcome.candidate.agentId} could not be inspected: ${outcome.diagnostic ?? "unknown platform error"}`
        : `The selected agent platform no longer has the conversation for agent ${outcome.candidate.agentId}, so it cannot be reopened.`;
  }
}

