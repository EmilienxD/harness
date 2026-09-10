import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_OWNED_BRANCH_PREFIXES,
  autoRunTargetBranchBlocker,
  branchName,
  commitSubject,
  explorationCommentBody,
  isAutoRunExplorationComment,
  issueClosedComment,
  issueCommentBody,
  classifyWorkerResult,
  nextStep,
  pullRequestBody,
  runPullRequestBody,
  runPullRequestTitle,
  sessionBranchName,
  slugify,
  type AutoRunPhase,
  type PlannedIssue,
  type RepositoryFacts,
} from "../src/domain/auto-run.js";

const issue: PlannedIssue = { number: 34, title: "Add retry backoff", disposition: "afk", branch: "issue/34-add-retry-backoff" };

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

function step(_expected: AutoRunPhase, overrides: Partial<RepositoryFacts> = {}, options: { readonly reviewMode?: boolean; readonly issue?: PlannedIssue } = {}) {
  return nextStep({
    issue: options.issue ?? issue,
    baseBranch: SESSION_BRANCH,
    reviewMode: options.reviewMode ?? false,
    facts: facts(overrides),
  });
}

const SESSION_BRANCH = "run/abc123";

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

test("run-owned branch names are generic and carry the issue number", () => {
  assert.deepEqual(RUN_OWNED_BRANCH_PREFIXES, ["issue/", "run/"]);
  assert.equal(branchName(34, "Add retry backoff"), "issue/34-add-retry-backoff");
  // Colliding slugs stay distinct because the number is part of the name.
  assert.notEqual(branchName(34, "Same title"), branchName(35, "Same title"));
});

test("run-owned branches are reserved and cannot become auto-run targets", () => {
  assert.match(autoRunTargetBranchBlocker("run/old") ?? "", /run-owned artifacts/);
  assert.match(autoRunTargetBranchBlocker("issue/34-old-issue") ?? "", /final run pull request/);
  assert.equal(autoRunTargetBranchBlocker("feature/wip"), undefined);
});

test("commit subject and pull request body are bounded and carry the closing trailer", () => {
  assert.equal(commitSubject("Add retry backoff"), "Add retry backoff");
  assert.ok(commitSubject("x".repeat(200)).length <= 72);
  assert.equal(pullRequestBody("Did the thing.", 34), "Did the thing.\n\nCloses #34");
  assert.equal(pullRequestBody("   ", 34), "Closes #34");
  assert.ok(pullRequestBody("y".repeat(5_000), 34).length <= 4_000 + "\n\nCloses #34".length);
});

test("a session branch is derived from the run id and stays out of the issue namespace", () => {
  assert.equal(sessionBranchName("run_k3f9x1"), "run/k3f9x1");
  // Same id, same branch: a resumed run finds the branch it created.
  assert.equal(sessionBranchName("run_k3f9x1"), sessionBranchName("run_k3f9x1"));
  assert.notEqual(sessionBranchName("run_a"), sessionBranchName("run_b"));
  assert.ok(sessionBranchName("run_k3f9x1").startsWith("run/"));
});

test("the run's pull request indexes what landed and closes nothing itself", () => {
  const landed = [
    { number: 34, title: "Add retry backoff", prNumber: 56 },
    { number: 35, title: "Trim the cache", prNumber: 57 },
  ];
  assert.equal(runPullRequestTitle(landed), "2 issues");
  assert.equal(runPullRequestTitle([landed[0]!]), "Add retry backoff");
  const body = runPullRequestBody(landed, "run/k3f9x1", "feature/wip");
  assert.match(body, /- #34 Add retry backoff \(PR #56\)/);
  assert.match(body, /- #35 Trim the cache \(PR #57\)/);
  assert.match(body, /run\/k3f9x1/);
  assert.doesNotMatch(body, /aboard|abd\//iu);
  assert.match(body, /feature\/wip/);
  // The issues are already closed; a second closing reference on a branch where
  // GitHub would honour it only invites reopen/close churn.
  assert.equal(/closes #/iu.test(body), false);
  const warned = runPullRequestBody(landed, "run/k3f9x1", "feature/wip", 2);
  assert.match(warned, /started with 2 commits on `feature\/wip` that `origin\/feature\/wip` did not contain/);
  assert.match(warned, /push `feature\/wip`.*use a merge commit/s);
  assert.ok(runPullRequestBody(
    Array.from({ length: 500 }, (_, index) => ({ number: index, title: "x".repeat(60), prNumber: index })),
    "run/k3f9x1",
    "main",
  ).length <= 4_000);
});

test("an issue-closing comment says where the work is without product branding", () => {
  const comment = issueClosedComment(56, "run/k3f9x1", "feature/wip");
  assert.match(comment, /#56/);
  assert.match(comment, /run\/k3f9x1/);
  assert.match(comment, /feature\/wip/);
  assert.doesNotMatch(comment, /aboard|abd\//iu);
});

test("an issue comment is the agent's own text, bounded, and absent when there is none", () => {
  assert.equal(issueCommentBody("  Rewrote the backoff.  "), "Rewrote the backoff.");
  assert.equal(issueCommentBody("   "), undefined);
  assert.ok((issueCommentBody("z".repeat(70_000)) ?? "").length <= 65_536);
});

test("exploration context is recognizable without hidden or product-specific markers", () => {
  const comment = explorationCommentBody({ runId: "run_test", issueNumber: 34, headSha: "a".repeat(40), report: "Found the boundary." });
  assert.match(comment, /^## Codebase context\n/);
  assert.doesNotMatch(comment, /<!--|aboard|abd\//iu);
  assert.equal(isAutoRunExplorationComment(comment), true);
  assert.equal(isAutoRunExplorationComment("## Codebase context\n\nA user-authored note."), false);
});

test("a worker's single commit on top of its starting tip is the success signal", () => {
  const committed = classifyWorkerResult("address-issue", {
    startingSha: "a".repeat(40),
    headSha: "b".repeat(40),
    dirtyPaths: [],
    descendsFromStart: true,
    newCommitCount: 1,
  });
  assert.deepEqual(committed, { kind: "committed", sha: "b".repeat(40) });
});

test("review-issue may finish untouched, but address-issue may not", () => {
  const untouched = { startingSha: "a".repeat(40), headSha: "a".repeat(40), dirtyPaths: [], descendsFromStart: true, newCommitCount: 0 } as const;
  assert.deepEqual(classifyWorkerResult("review-issue", untouched), { kind: "unchanged" });
  const rejected = classifyWorkerResult("address-issue", untouched);
  assert.equal(rejected.kind, "rejected");
  assert.match(rejected.kind === "rejected" ? rejected.reason : "", /without committing/);
});

test("residual changes reject a worker even when it also committed", () => {
  for (const role of ["address-issue", "review-issue"] as const) {
    const outcome = classifyWorkerResult(role, {
      startingSha: "a".repeat(40),
      headSha: "b".repeat(40),
      dirtyPaths: ["src/a.ts", "src/b.ts"],
      descendsFromStart: true,
      newCommitCount: 1,
    });
    assert.equal(outcome.kind, "rejected", role);
    assert.match(outcome.kind === "rejected" ? outcome.reason : "", /2 uncommitted path/);
  }
});

test("rewritten history and extra commits are rejected", () => {
  const moved = classifyWorkerResult("address-issue", {
    startingSha: "a".repeat(40),
    headSha: "b".repeat(40),
    dirtyPaths: [],
    descendsFromStart: false,
    newCommitCount: 0,
  });
  assert.equal(moved.kind, "rejected");
  assert.match(moved.kind === "rejected" ? moved.reason : "", /moved HEAD off/);

  const extra = classifyWorkerResult("review-issue", {
    startingSha: "a".repeat(40),
    headSha: "b".repeat(40),
    dirtyPaths: [],
    descendsFromStart: true,
    newCommitCount: 3,
  });
  assert.equal(extra.kind, "rejected");
  assert.match(extra.kind === "rejected" ? extra.reason : "", /created 3 commits/);
});

test("the reducer walks the phases in order from a clean start", () => {
  // The base is the run's session branch, never the repository's default one.
  assert.deepEqual(step("branch", { branchExists: false, currentBranch: "main" }), { action: "branch", branch: issue.branch, base: SESSION_BRANCH });
  assert.deepEqual(step("implement"), { action: "implement", issue });
  // The worker committed; the commit phase only publishes what it produced.
  assert.deepEqual(step("commit", { hasCommit: true }), { action: "commit", issue });
});

test("uncommitted changes stop the run instead of feeding a worker or a commit", () => {
  const dirty = { workingTreeDirty: true, dirtyPaths: ["src/a.ts"] } as const;
  const beforeImplementation = step("implement", dirty);
  assert.equal(beforeImplementation.action, "stop");
  assert.match(beforeImplementation.action === "stop" ? beforeImplementation.reason : "", /src\/a\.ts/);

  const afterImplementation = step("commit", { ...dirty, hasCommit: true });
  assert.equal(afterImplementation.action, "stop");

  const nothingCommitted = step("commit", { pullRequest: { number: 56, state: "open", approvedByOther: false } });
  assert.deepEqual(nothingCommitted, { action: "stop", reason: `address-issue produced no commit for issue #${issue.number}` });
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

test("a merged pull request reaches cleanup even when its disposable branch is gone", () => {
  const outcome = step("merge", {
    branchExists: false,
    currentBranch: SESSION_BRANCH,
    hasCommit: false,
    commitPushed: false,
    pullRequest: { number: 56, state: "merged", approvedByOther: false },
  });
  assert.deepEqual(outcome, { action: "cleanup", issue });
});

test("a branch with a pull request but nothing to commit is a failure, not a commit", () => {
  const outcome = step("commit", {
    workingTreeDirty: false,
    hasCommit: false,
    pullRequest: { number: 56, state: "open", approvedByOther: false },
  });
  assert.equal(outcome.action, "stop");
  assert.match((outcome as { reason: string }).reason, /produced no commit/);
});

test("uncommitted work on the wrong branch stops the run instead of being checked out over", () => {
  const outcome = step("branch", { workingTreeDirty: true, currentBranch: "main" });
  assert.equal(outcome.action, "stop");
  assert.match((outcome as { reason: string }).reason, /on main with uncommitted work.*belongs on issue\/34-add-retry-backoff/);
});

test("review runs only when enabled and only once", () => {
  const open = { number: 56, state: "open", approvedByOther: false } as const;
  const base = { hasCommit: true, commitPushed: true, pullRequest: open };
  assert.deepEqual(step("review", base, { reviewMode: true }), { action: "review", issue, prNumber: 56 });
  assert.deepEqual(step("review", base, { reviewMode: false }), { action: "merge", issue, prNumber: 56 });
  assert.deepEqual(step("review", { ...base, reviewed: true }, { reviewMode: true }), { action: "merge", issue, prNumber: 56 });
});

test("a hitl issue waits at the gate and continues on merge or third-party approval", () => {
  const hitl: PlannedIssue = { ...issue, number: 35, disposition: "hitl", branch: "issue/35-migrate-the-queue" };
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
