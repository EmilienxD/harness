import type { DelegationCoordinator } from "../bridge/delegation.js";
import type { PullRequestOwner } from "../auto/engine.js";
import type { TerminalId } from "../domain/contracts.js";
import type { GitHubClient } from "./client.js";

export interface ReviewRequest {
  /** Optional: the default is "whatever pull request is currently in flight". */
  readonly pr?: number;
  readonly focus?: string;
}

export type ReviewOutcome =
  | { readonly action: "none"; readonly reason: "no-open-pull-request" }
  | { readonly action: "focused"; readonly prNumber: number; readonly agentId: string; readonly type: string; readonly unusedFocus?: string }
  | { readonly action: "resumed"; readonly prNumber: number; readonly agentId: string; readonly type: string; readonly unusedFocus?: string }
  | { readonly action: "launched"; readonly prNumber: number; readonly agentId: string; readonly notice: string };

/** Looks up who owns a pull request; the auto-run engine is the only source. */
export interface PullRequestOwnership {
  owner(prNumber: number): PullRequestOwner | undefined;
}

export interface ReviewTerminals {
  /** Focuses a live terminal, or reports that it is gone. */
  focus(terminalId: TerminalId): boolean;
  /** Relaunches `claude --resume <sessionId>` into a new terminal. */
  resume(owner: PullRequestOwner): Promise<void>;
}

/**
 * `review_pr` is the way back into work already in flight
 * (`AGENTS.md`). It no longer launches a reviewer: it finds
 * the agent that owns the open pull request — the implementer when review mode
 * is off, the pr-doctor when it is on — and hands that session to the user, who
 * continues from there. This is a handoff, so it returns no result; the Manager
 * learns what happened from the `UserPromptSubmit` drain on the next message.
 */
export class ReviewCoordinator {
  public constructor(
    private readonly github: GitHubClient,
    private readonly delegation: Pick<DelegationCoordinator, "launchInteractive">,
    private readonly ownership: PullRequestOwnership,
    private readonly terminals: ReviewTerminals,
  ) {}

  public async review(request: ReviewRequest = {}): Promise<ReviewOutcome> {
    const prNumber = request.pr ?? await this.github.findLatestOpenPullRequest();
    if (prNumber === undefined) return { action: "none", reason: "no-open-pull-request" };

    const owner = this.ownership.owner(prNumber);
    if (owner !== undefined) {
      // A focus has nowhere to go on these two branches: showing a live terminal
      // sends nothing, and `--resume` re-passes the original flags with no new
      // prompt. Report it back rather than dropping it silently — the caller
      // cannot predict which branch it lands on, so an unreported discard makes
      // the parameter look honored when it was not.
      const unused = request.focus === undefined ? {} : { unusedFocus: request.focus };
      if (this.terminals.focus(owner.terminalId)) {
        return { action: "focused", prNumber, agentId: owner.agentId, type: owner.type, ...unused };
      }
      // Resume is safe here: the agent has already run, so a transcript exists.
      // The closed-before-first-message case that breaks `--resume` cannot apply
      // to a worker that produced a commit.
      await this.terminals.resume(owner);
      return { action: "resumed", prNumber, agentId: owner.agentId, type: owner.type, ...unused };
    }

    // No record of the owning session — the extension restarted, or the pull
    // request was opened outside a run. A fresh doctor against the diff is the
    // nearest useful thing, and saying so keeps the substitution visible.
    // No auto-run owns this pull request, so nothing is committing behind the
    // terminal: it is a handoff and takes no write lease. The user may already
    // be editing the same branch, and that is theirs to decide.
    const launched = await this.delegation.launchInteractive({
      type: "pr-doctor-hitl",
      pullRequest: prNumber,
      description: `review pull request ${prNumber}`,
      ...(request.focus === undefined ? {} : { focus: request.focus }),
    }, "manager");
    return {
      action: "launched",
      prNumber,
      agentId: launched.agentId,
      notice: `No aboard session is recorded for PR #${prNumber}, so a fresh pr-doctor-hitl was launched against its diff instead of resuming one.`,
    };
  }
}
