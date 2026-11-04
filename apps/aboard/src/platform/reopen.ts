
import type { NativeSession } from "./native-sessions.js";
import type { IsoTimestamp } from "../domain/contracts.js";
import type { InteractiveLaunchHandles, ReopenTarget } from "../bridge/delegation.js";
import { type AgentId, type AgentPlatformId, type AgentType, type SessionId, type TerminalId } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import { sessionTitleLabel } from "../domain/session-title.js";
import {
  reopenCandidates,
  type ActivityDto,
  type ReopenCandidate,
} from "../domain/activity.js";

/** Why a recorded session cannot be reopened, as the user is told it. */
export type UnresumableReason =
  "no-transcript" | "inspection-failed" | "execution-active";

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
  readonly discover?: (publish?: (sessions: readonly NativeSession[]) => void, signal?: AbortSignal) => Promise<readonly NativeSession[]>;
  readonly allocateAgentId?: () => AgentId;
  readonly activity: ReopenActivitySource;
  readonly fleet: FleetRegistry;
  readonly terminals: ReopenTerminals;
  readonly launcher: ReopenSessionLauncher;
  readonly isResumable: (platform: AgentPlatformId, sessionId: SessionId, cwd?: string, type?: AgentType) => Promise<boolean>;
}

const TYPE_SELECTORS: Readonly<Record<string, AgentType>> = {
  interactive: "interactive",
  explore: "explore",
  prototype: "prototype",
  brainstorm: "brainstorm",
  websearch: "websearch",
  general: "general",
  address: "address",
  review: "review",
};

export class ReopenCoordinator {
  public constructor(private readonly options: ReopenCoordinatorOptions) {}

  public async list(publish?: (options: readonly ReopenOption[]) => void, signal?: AbortSignal): Promise<readonly ReopenOption[]> {
    const recorded = reopenCandidates(
      this.options.activity.entries(),
      this.options.fleet.list(),
      (terminalId) => this.options.terminals.isOpen(terminalId),
    );
    const candidates = [...recorded];
    const indices = new Map(candidates.map((candidate, index) => [`${candidate.platform}:${candidate.sessionId}`, index]));
    const snapshot = (): readonly ReopenOption[] => [...candidates].sort((a, b) => b.at.localeCompare(a.at)).map((candidate) => ({ candidate, resumable: true }));
    const merge = (sessions: readonly NativeSession[]) => {
      for (const native of sessions) {
        const key = `${native.platform}:${native.sessionId}`;
        const index = indices.get(key);
        if (index !== undefined) {
          const candidate = candidates[index]!;
          candidates[index] = { ...candidate, at: native.at as IsoTimestamp, ...(native.title ? { title: native.title } : {}) };
        } else {
          indices.set(key, candidates.length);
          candidates.push({ ...native, at: native.at as IsoTimestamp, agentId: `native:${native.platform}:${native.sessionId}` as AgentId, type: "interactive", origin: "native", description: native.platform });
        }
      }
      if (!signal?.aborted) publish?.(snapshot());
    };
    publish?.(snapshot());
    merge(await this.options.discover?.(merge, signal) ?? []);
    if (signal?.aborted) return snapshot();
    candidates.sort((a, b) => b.at.localeCompare(a.at));
    const inspect = async (candidate: ReopenCandidate): Promise<ReopenOption | undefined> => {
      if (candidate.origin !== "live") return { candidate, resumable: true };
      try {
        const resumable = await this.options.isResumable(candidate.platform, candidate.sessionId, candidate.cwd, candidate.type);
        // An open provider terminal can still be an empty TUI or contain only local commands.
        if (candidate.origin === "live" && !resumable) return undefined;
        return resumable ? { candidate, resumable } : { candidate, resumable, reason: "no-transcript" };
      } catch (error) {
        return {
          candidate,
          resumable: false,
          reason: "inspection-failed",
          diagnostic: error instanceof Error ? error.message : "The selected agent platform could not inspect the conversation",
        };
      }
    };
    // A native catalogue may contain hundreds of sessions. Bound provider processes and disk reads.
    const inspected: (ReopenOption | undefined)[] = [];
    for (let offset = 0; offset < candidates.length; offset += 4) {
      inspected.push(...await Promise.all(candidates.slice(offset, offset + 4).map(inspect)));
    }
    return inspected.filter((option): option is ReopenOption => option !== undefined);
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
      preserveSessionModel: true,
      executionMode: "interactive",
      platform: candidate.platform,
      agentId: candidate.origin === "native" ? this.options.allocateAgentId?.() ?? candidate.agentId : candidate.agentId,
      type: candidate.type,
      sessionId: candidate.sessionId,
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
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
      return `Focused ${sessionTitleLabel(outcome.candidate.title)}.`;
    case "reopened":
      return `Reopened ${sessionTitleLabel(outcome.candidate.title)} and handed it back to you.`;
    case "unresumable":
      if (outcome.reason === "execution-active") return `${sessionTitleLabel(outcome.candidate.title)} has a running or uncertain execution; resume refused.`;
      return outcome.reason === "inspection-failed"
        ? `${sessionTitleLabel(outcome.candidate.title)} could not be inspected: ${outcome.diagnostic ?? "unknown platform error"}`
        : `The selected agent platform no longer has ${sessionTitleLabel(outcome.candidate.title)}, so it cannot be reopened.`;
  }
}

