import type { DelegationCoordinator } from "../bridge/delegation.js";
import type { AgentId, AgentSession } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import type { GitHubClient } from "./client.js";

export type AutoReviewSetting = "never" | "hitl" | "all";

export interface ReviewRequest {
  readonly pr: number;
  readonly focus?: string;
}

export type FixRoute =
  | { readonly route: "original-implementer"; readonly agentId: AgentId; readonly result: unknown }
  | { readonly route: "fixer"; readonly result: unknown }
  | { readonly route: "none"; readonly reason: "no-unresolved-threads" };

export class ReviewCoordinator {
  public constructor(
    private readonly github: GitHubClient,
    private readonly delegation: DelegationCoordinator,
    private readonly fleet: FleetRegistry,
  ) {}

  /** Explicit user/Manager action. The setting is intentionally irrelevant here. */
  public async review(request: ReviewRequest): Promise<unknown> {
    return this.delegation.spawn({
      type: "reviewer",
      prompt: "Review this pull request against its resolved contract and persist every finding as a line-specific GitHub review comment.",
      description: `review pull request ${request.pr}`,
      pullRequest: request.pr,
      ...(request.focus === undefined ? {} : { focus: request.focus }),
    });
  }

  /** The sole automatic path; the configured choice is used verbatim. */
  public async maybeAutoReview(request: ReviewRequest, setting: AutoReviewSetting): Promise<unknown | undefined> {
    if (setting === "never") return undefined;
    const pullRequest = await this.github.getPullRequest(request.pr);
    if (pullRequest === undefined) return undefined;
    if (setting === "hitl") {
      const issue = pullRequest.issueNumber === undefined ? undefined : await this.github.getIssue(pullRequest.issueNumber);
      if (!issue?.labels.some((label) => label.toLowerCase() === "hitl")) return undefined;
    }
    return this.review(request);
  }

  public async routeFixes(pr: number): Promise<FixRoute> {
    const threads = (await this.github.listReviewThreads(pr)).filter((thread) => !thread.isResolved);
    if (threads.length === 0) return { route: "none", reason: "no-unresolved-threads" };
    const pullRequest = await this.github.getPullRequest(pr);
    const original = pullRequest?.issueNumber === undefined
      ? undefined
      : this.#originalImplementer(pullRequest.issueNumber);
    const message = `Address the ${threads.length} unresolved review thread${threads.length === 1 ? "" : "s"} on pull request #${pr}. The bridge will resolve the current threads before launch.`;
    if (original !== undefined && original.lifecycle.status !== "running" && original.lifecycle.status !== "starting") {
      return { route: "original-implementer", agentId: original.identity.agentId, result: await this.delegation.send(original.identity.agentId, message) };
    }
    return {
      route: "fixer",
      result: await this.delegation.spawn({
        type: "fixer",
        prompt: message,
        description: `fix pull request ${pr}`,
        pullRequest: pr,
        ...(pullRequest?.issueNumber === undefined ? {} : { issue: pullRequest.issueNumber }),
      }),
    };
  }

  #originalImplementer(issueNumber: number): AgentSession | undefined {
    return [...this.fleet.list()]
      .reverse()
      .find((session) => session.identity.type === "implementer" && session.issueNumber === issueNumber);
  }
}
