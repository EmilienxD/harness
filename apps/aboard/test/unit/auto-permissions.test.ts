import assert from "node:assert/strict";
import test from "node:test";

import { AUTO_RUN_RESTRICTIONS } from "../../src/auto/permissions.js";

test("auto-run denies mutating git and GitHub commands without denying their read surfaces", () => {
  for (const rule of [
    "git worktree*", "git push*", "git revert*", "gh api*", "gh issue create*",
    "gh issue comment*", "gh pr review*", "gh pr merge*", "gh pr revert*",
    "gh discussion comment*", "gh repo autolink create*", "gh workflow run*",
  ]) {
    assert.ok(AUTO_RUN_RESTRICTIONS.deniedCommands.includes(rule), rule);
  }
  assert.equal(AUTO_RUN_RESTRICTIONS.denySubagents, true);
  assert.equal(AUTO_RUN_RESTRICTIONS.denyWeb, true);

  // Staging and committing are the completion signal, and these broad rules
  // would also remove the read-only evidence workers need.
  for (const rule of [
    "git add*", "git commit*", "git *", "gh *", "gh issue *", "gh pr *",
    "git status*", "git diff*", "git log*", "gh issue view*", "gh issue list*",
    "gh pr view*", "gh pr diff*",
  ]) {
    assert.ok(!AUTO_RUN_RESTRICTIONS.deniedCommands.includes(rule), rule);
  }

  // `git commit-graph` writes to the object store and is not the completion
  // signal, so allowing `git commit` must not have allowed it too.
  assert.ok(AUTO_RUN_RESTRICTIONS.deniedCommands.includes("git commit-graph*"));
});
