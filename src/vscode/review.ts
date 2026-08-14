import type { Disposable } from "vscode";

import type { ReviewCoordinator, ReviewOutcome } from "../github/review.js";

export interface ReviewCommandHost {
  registerCommand(command: string, callback: (...args: readonly unknown[]) => unknown): Disposable;
  info(message: string): void;
  error(message: string): void;
}

/**
 * The panel entry point for `review_pr` (`AGENTS.md`). It
 * asks for nothing: the action is "reopen the session for the pull request
 * currently in flight", and the extension already knows which that is. A number
 * may still be passed positionally from a tree item.
 */
export function registerReviewCommand(host: ReviewCommandHost, reviews: ReviewCoordinator): Disposable {
  return host.registerCommand("aboard.reviewPr", async (...args) => {
    const pr = typeof args[0] === "number" && Number.isInteger(args[0]) && args[0] > 0 ? args[0] : undefined;
    try {
      host.info(describe(await reviews.review(pr === undefined ? {} : { pr })));
    } catch (error) {
      host.error(error instanceof Error ? error.message : "Unable to reopen the pull request session");
    }
  });
}

function describe(outcome: ReviewOutcome): string {
  switch (outcome.action) {
    case "none": return "No pull request is open, so there is no session to reopen.";
    case "focused": return `Focused the ${outcome.type} terminal for PR #${outcome.prNumber}.`;
    case "resumed": return `Resumed the ${outcome.type} session for PR #${outcome.prNumber}.`;
    case "launched": return outcome.notice;
  }
}
