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
      const unused = request.focus === undefined ? {} : { unusedFocus: request.focus };
      if (this.terminals.focus(owner.terminalId)) {
        return { action: "focused", prNumber, agentId: owner.agentId, type: owner.type, ...unused };
      }
      await this.terminals.resume(owner);
      return { action: "resumed", prNumber, agentId: owner.agentId, type: owner.type, ...unused };
    }

    const launched = await this.delegation.launchInteractive({
      type: "reviewer",
      pullRequest: prNumber,
      description: `review pull request ${prNumber}`,
      ...(request.focus === undefined ? {} : { focus: request.focus }),
    }, "user");
    return {
      action: "launched",
      prNumber,
      agentId: launched.agentId,
      notice: `No aboard session is recorded for PR #${prNumber}, so a fresh reviewer was launched against its diff instead of resuming one.`,
    };
  }
}
