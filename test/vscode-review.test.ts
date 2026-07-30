import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewCoordinator } from "../src/github/review.js";
import { registerReviewCommand, type ReviewCommandHost } from "../src/vscode/review.js";

test("VS Code review action validates or accepts a PR and launches the same review path", async () => {
  let callback: ((...args: readonly unknown[]) => unknown) | undefined;
  const reviewed: number[] = [];
  const host: ReviewCommandHost = {
    registerCommand: (_command, registered) => { callback = registered; return { dispose() {} }; },
    input: async (options) => {
      assert.equal(options.validateInput("0"), "Enter a positive pull request number");
      assert.equal(options.validateInput("42"), undefined);
      return "42";
    },
    error: () => assert.fail("review should not fail"),
  };
  const reviews = { review: async ({ pr }: { pr: number }) => { reviewed.push(pr); } } as ReviewCoordinator;
  registerReviewCommand(host, reviews);
  await callback?.();
  await callback?.(17);
  assert.deepEqual(reviewed, [42, 17]);
});
