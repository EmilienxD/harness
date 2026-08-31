import type { Disposable } from "vscode";

import type { ReviewCoordinator, ReviewOutcome } from "../github/review.js";

export interface ReviewCommandHost {
  registerCommand(command: string, callback: (...args: readonly unknown[]) => unknown): Disposable;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export function registerReviewCommand(host: ReviewCommandHost, reviews: ReviewCoordinator): Disposable {
  return host.registerCommand("aboard.reviewPr", async (...args) => {
    const pr = typeof args[0] === "number" && Number.isInteger(args[0]) && args[0] > 0 ? args[0] : undefined;
    try {
      const outcome = await reviews.review(pr === undefined ? {} : { pr });
      if (outcome.action === "none") host.info(describe(outcome));
      else if ((outcome.action === "focused" || outcome.action === "resumed") && outcome.unusedFocus !== undefined) {
        host.warning(unusedFocusNote(outcome.unusedFocus).trim());
      }
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

/** A focus only steers a fallback session; anywhere else it is reported, never silently dropped. */
function unusedFocusNote(focus: string | undefined): string {
  return focus === undefined
    ? ""
    : " The focus text was not applied — that session is already loaded; type it in the terminal.";
}
