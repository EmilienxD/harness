import assert from "node:assert/strict";
import test from "node:test";

import {
  branchName,
  commitSubject,
  nextStep,
  pullRequestBody,
  selectIssues,
  slugify,
  type AutoRunPhase,
  type PlannedIssue,
  type RepositoryFacts,
} from "../src/domain/auto-run.js";

const issue: PlannedIssue = { number: 34, title: "Add retry backoff", disposition: "afk", branch: "aboard/34-add-retry-backoff" };

function facts(overrides: Partial<RepositoryFacts> = {}): RepositoryFacts {
  return {
    currentBranch: issue.branch,
    branchExists: true,
    workingTreeDirty: false,
    dirtyPaths: [],
    hasCommit: false,
    commitPushed: false,
    pullRequest: undefined,
    reviewed: false,
    issueClosed: false,
    ...overrides,
  };
}

/**
 * `expected` names the phase the facts should select; the reducer takes no phase
 * of its own, because the observed repository is what decides where the run is.
 */
function step(_expected: AutoRunPhase, overrides: Partial<RepositoryFacts> = {}, options: { readonly reviewMode?: boolean; readonly issue?: PlannedIssue } = {}) {
  return nextStep({
    issue: options.issue ?? issue,
    defaultBranch: "main",
    reviewMode: options.reviewMode ?? false,
    facts: facts(overrides),
  });
}

test("slug normalization collapses punctuation, trims, and never cuts mid-word", () => {
  assert.equal(slugify("Add retry backoff"), "add-retry-backoff");
  assert.equal(slugify("  Fix the --weird-- input!!  "), "fix-the-weird-input");
  assert.equal(slugify("C++ / C#: interop"), "c-c-interop");
  // 40 characters lands inside "boundaries", so the cut retreats to the hyphen.
  assert.equal(slugify("Validate every single incoming request boundaries"), "validate-every-single-incoming-request");
  assert.ok(slugify("Validate every single incoming request boundaries").length <= 40);
  assert.equal(slugify("!!!"), "issue");
  assert.equal(slugify("日本語のタイトル"), "issue");
  // A first word longer than the budget has no boundary to retreat to.
  assert.equal(slugify(`${"a".repeat(60)}`), "a".repeat(40));
});

test("branch names carry the issue number so a branch is greppable back to it", () => {
  assert.equal(branchName(34, "Add retry backoff"), "aboard/34-add-retry-backoff");
  // Colliding slugs stay distinct because the number is part of the name.
  assert.notEqual(branchName(34, "Same title"), branchName(35, "Same title"));
});

test("commit subject and pull request body are bounded and carry the closing trailer", () => {
  assert.equal(commitSubject("Add retry backoff"), "Add retry backoff");
  assert.ok(commitSubject("x".repeat(200)).length <= 72);
  assert.equal(pullRequestBody("Did the thing.", 34), "Did the thing.\n\nCloses #34");
  assert.equal(pullRequestBody("   ", 34), "Closes #34");
  assert.ok(pullRequestBody("y".repeat(5_000), 34).length <= 4_000 + "\n\nCloses #34".length);
});

test("the reducer walks the phases in order from a clean start", () => {
  assert.deepEqual(step("branch", { branchExists: false, currentBranch: "main" }), { action: "branch", branch: issue.branch, base: "main" });
  assert.deepEqual(step("implement"), { action: "implement", issue });
  assert.deepEqual(step("commit", { workingTreeDirty: true, dirtyPaths: ["src/a.ts"] }), { action: "commit", issue });
});

test("every already-satisfied postcondition short circuits", () => {
  // Branch exists and is checked out, a pushed commit is present, and a PR is
  // open: an afk issue with review off goes straight to merge.
  const resumed = step("branch", {
    hasCommit: true,
    commitPushed: true,
    pullRequest: { number: 56, state: "open", approvedByOther: false },
  });
  assert.deepEqual(resumed, { action: "merge", issue, prNumber: 56 });
  // Already merged: nothing left but cleanup.
  assert.deepEqual(
    step("merge", { hasCommit: true, commitPushed: true, pullRequest: { number: 56, state: "merged", approvedByOther: false } }),
    { action: "cleanup", issue },
  );
});

test("a branch with a pull request but nothing to commit is a failure, not a commit", () => {
  const outcome = step("commit", {
    workingTreeDirty: false,
    hasCommit: false,
    pullRequest: { number: 56, state: "open", approvedByOther: false },
  });
  assert.equal(outcome.action, "stop");
  assert.match((outcome as { reason: string }).reason, /produced no changes/);
});

test("uncommitted work on the wrong branch stops the run instead of being checked out over", () => {
  const outcome = step("branch", { workingTreeDirty: true, currentBranch: "main" });
  assert.equal(outcome.action, "stop");
  assert.match((outcome as { reason: string }).reason, /on main with uncommitted work.*belongs on aboard\/34-add-retry-backoff/);
});

test("review runs only when enabled and only once", () => {
  const open = { number: 56, state: "open", approvedByOther: false } as const;
  const base = { hasCommit: true, commitPushed: true, pullRequest: open };
  assert.deepEqual(step("review", base, { reviewMode: true }), { action: "review", issue, prNumber: 56 });
  assert.deepEqual(step("review", base, { reviewMode: false }), { action: "merge", issue, prNumber: 56 });
  assert.deepEqual(step("review", { ...base, reviewed: true }, { reviewMode: true }), { action: "merge", issue, prNumber: 56 });
});

test("a hitl issue waits at the gate and continues on merge or third-party approval", () => {
  const hitl: PlannedIssue = { ...issue, number: 35, disposition: "hitl", branch: "aboard/35-migrate-the-queue" };
  const base = { hasCommit: true, commitPushed: true, currentBranch: hitl.branch };
  const waiting = step("await-approval", { ...base, pullRequest: { number: 57, state: "open", approvedByOther: false } }, { issue: hitl });
  assert.deepEqual(waiting, { action: "await-approval", issue: hitl, prNumber: 57 });

  const approved = step("await-approval", { ...base, pullRequest: { number: 57, state: "open", approvedByOther: true } }, { issue: hitl });
  assert.deepEqual(approved, { action: "merge", issue: hitl, prNumber: 57 });

  const merged = step("await-approval", { ...base, pullRequest: { number: 57, state: "merged", approvedByOther: false } }, { issue: hitl });
  assert.deepEqual(merged, { action: "cleanup", issue: hitl });

  const rejected = step("await-approval", { ...base, pullRequest: { number: 57, state: "closed", approvedByOther: false } }, { issue: hitl });
  assert.equal(rejected.action, "stop");
  assert.match((rejected as { reason: string }).reason, /closed without merging/);
});

test("an afk issue has no approval gate", () => {
  const outcome = step("await-approval", {
    hasCommit: true,
    commitPushed: true,
    pullRequest: { number: 56, state: "open", approvedByOther: false },
  });
  assert.deepEqual(outcome, { action: "merge", issue, prNumber: 56 });
});

test("selection skips unclassified, defers blocked, and orders by number", () => {
  const selection = selectIssues([
    { number: 37, title: "Later", labels: ["afk"], state: "open", openBlockedByNumbers: [35] },
    { number: 35, title: "Migrate the queue", labels: ["hitl"], state: "open", openBlockedByNumbers: [] },
    { number: 34, title: "Add retry backoff", labels: ["afk"], state: "open", openBlockedByNumbers: [] },
    { number: 36, title: "Unlabelled", labels: [], state: "open", openBlockedByNumbers: [] },
    { number: 38, title: "Already done", labels: ["afk"], state: "closed", openBlockedByNumbers: [] },
  ]);
  assert.deepEqual(selection.issues.map((entry) => entry.number), [34, 35]);
  assert.deepEqual(selection.issues.map((entry) => entry.disposition), ["afk", "hitl"]);
  assert.deepEqual(selection.skipped, [
    { number: 36, reason: "unclassified: neither afk nor hitl" },
    { number: 37, reason: "blocked by open #35" },
  ]);
});

test("a blocked issue becomes selectable once its dependency closes", () => {
  const before = selectIssues([{ number: 37, title: "Later", labels: ["afk"], state: "open", openBlockedByNumbers: [35] }]);
  assert.equal(before.issues.length, 0);
  const after = selectIssues([{ number: 37, title: "Later", labels: ["afk"], state: "open", openBlockedByNumbers: [] }]);
  assert.deepEqual(after.issues.map((entry) => entry.number), [37]);
});

test("hitl wins a contradictory label pair because only a human may close it", () => {
  const selection = selectIssues([{ number: 40, title: "Both", labels: ["afk", "hitl"], state: "open", openBlockedByNumbers: [] }]);
  assert.equal(selection.issues[0]?.disposition, "hitl");
});
