import type { Disposable } from "vscode";

import type { ReviewCoordinator } from "../github/review.js";

export interface ReviewCommandHost {
  registerCommand(command: string, callback: (...args: readonly unknown[]) => unknown): Disposable;
  input(options: { readonly prompt: string; readonly placeHolder: string; readonly validateInput: (value: string) => string | undefined }): Promise<string | undefined>;
  error(message: string): void;
}

/** Registers the PR action without coupling review orchestration to VS Code APIs. */
export function registerReviewCommand(host: ReviewCommandHost, reviews: ReviewCoordinator): Disposable {
  return host.registerCommand("aboard.reviewPr", async (...args) => {
    const provided = typeof args[0] === "number" ? String(args[0]) : undefined;
    const value = provided ?? await host.input({
      prompt: "Pull request to review",
      placeHolder: "42",
      validateInput: (candidate) => /^\d+$/.test(candidate) && Number(candidate) > 0 ? undefined : "Enter a positive pull request number",
    });
    if (value === undefined) return;
    try {
      await reviews.review({ pr: Number(value) });
    } catch (error) {
      host.error(error instanceof Error ? error.message : "Unable to launch pull request review");
    }
  });
}
