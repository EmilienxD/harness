import assert from "node:assert/strict";
import test from "node:test";

import { AUTO_RUN_DISALLOWED_TOOLS } from "../src/auto/permissions.js";

test("auto-run denies mutating git and GitHub commands without denying their read surfaces", () => {
  for (const rule of [
    "Bash(git worktree*)",
    "Bash(git add*)",
    "Bash(git commit*)",
    "Bash(git push*)",
    "Bash(git revert*)",
    "Bash(gh api*)",
    "Bash(gh issue create*)",
    "Bash(gh issue comment*)",
    "Bash(gh pr review*)",
    "Bash(gh pr merge*)",
    "Bash(gh pr revert*)",
    "Bash(gh discussion comment*)",
    "Bash(gh repo autolink create*)",
    "Bash(gh workflow run*)",
  ]) {
    assert.ok(AUTO_RUN_DISALLOWED_TOOLS.includes(rule), rule);
  }

  // These broad rules would also remove the read-only evidence workers need.
  for (const rule of [
    "Bash(git *)",
    "Bash(gh *)",
    "Bash(gh issue *)",
    "Bash(gh pr *)",
    "Bash(git status*)",
    "Bash(git diff*)",
    "Bash(git log*)",
    "Bash(gh issue view*)",
    "Bash(gh issue list*)",
    "Bash(gh pr view*)",
    "Bash(gh pr diff*)",
  ]) {
    assert.ok(!AUTO_RUN_DISALLOWED_TOOLS.includes(rule), rule);
  }
});
