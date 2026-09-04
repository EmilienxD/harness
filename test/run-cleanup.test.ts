import assert from "node:assert/strict";
import test from "node:test";

import { describeDiscard, planDiscard, type DiscardBehavior } from "../src/domain/run-cleanup.js";
import type { AutoRunRecord } from "../src/domain/run-plan.js";
import type { RunObservations } from "../src/domain/run-validation.js";

const SESSION = "abd/run/test";
const SHA = (seed: string) => seed.repeat(40).slice(0, 40);

function record(overrides: Partial<AutoRunRecord> = {}): AutoRunRecord {
  return {
    version: 2,
    runId: "run_test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempt: 1,
    settings: {
      review: false,
      exploreBeforeImplement: false,
      recursiveIssueReferences: false,
      mergeStrategy: "squash",
      mergeRunPullRequest: false,
      pauseAfterHitl: false,
      pollSeconds: 30,
      worktree: { enabled: true, root: "", keep: false, setupTimeoutSeconds: 600 },
      workspaceRoot: "C:/checkouts/run_test/repo",
    },
    plan: [
      { number: 34, title: "One", branch: "abd/34-one", disposition: "afk", dependsOn: [] },
      { number: 35, title: "Two", branch: "abd/35-two", disposition: "afk", dependsOn: [] },
      { number: 36, title: "Three", branch: "abd/36-three", disposition: "afk", dependsOn: [] },
    ],
    progress: {
      "34": { state: "done", result: "landed", prNumber: 56, issueClosed: true },
      "35": { state: "current", phase: "merge", prNumber: 57 },
      "36": { state: "pending" },
    },
    sessionBranch: SESSION,
    targetBranch: "feature/wip",
    branchShas: { [SESSION]: SHA("a"), "abd/34-one": SHA("b"), "abd/35-two": SHA("c") },
    currentIssue: 35,
    checkpoint: "issue",
    runPullRequest: 60,
    reviewedIssues: [],
    workspaceCreated: true,
    ...overrides,
  };
}

function observations(overrides: Partial<RunObservations> = {}): RunObservations {
  return {
    repositoryUsable: true,
    gitHubAuthenticated: true,
    targetBranchExists: true,
    workspacePresent: true,
    branches: [
      { name: SESSION, localSha: SHA("a"), remoteSha: SHA("a") },
      { name: "abd/34-one", localSha: SHA("b"), remoteSha: SHA("b") },
      { name: "abd/35-two", localSha: SHA("c"), remoteSha: SHA("c") },
      { name: "abd/36-three", localSha: undefined, remoteSha: undefined },
    ],
    issues: [],
    pullRequests: [
      { number: 56, state: "merged", head: "abd/34-one", base: SESSION, approvedByOther: false },
      { number: 57, state: "open", head: "abd/35-two", base: SESSION, approvedByOther: false },
      { number: 60, state: "open", head: SESSION, base: "feature/wip", approvedByOther: false },
    ],
    workingTree: { branch: SESSION, dirtyPaths: [] },
    titles: {},
    ...overrides,
  };
}

const plan = (behavior: DiscardBehavior, current = record(), observed = observations()) =>
  planDiscard(current, behavior, observed);

test("record-only removes nothing at all", () => {
  const result = plan("record-only");
  assert.deepEqual(result.localBranches, []);
  assert.deepEqual(result.remoteBranches, []);
  assert.deepEqual(result.pullRequests, []);
  assert.equal(result.closeTerminals, false);
  assert.equal(result.removeWorkspace, false);
  assert.match(describeDiscard(result), /Forget the run record only/);
});

test("local cleanup takes terminals, a clean checkout, and unchanged local branches only", () => {
  const result = plan("local-cleanup");
  assert.equal(result.closeTerminals, true);
  assert.equal(result.removeWorkspace, true);
  // #34 landed, so its branch carries merged work and stays. #36 was never
  // started, so the run recorded no SHA and cannot prove it owns anything.
  assert.deepEqual(result.localBranches.map((branch) => branch.name), [SESSION, "abd/35-two"]);
  // Remote branches and pull requests are a full cleanup's business.
  assert.deepEqual(result.remoteBranches, []);
  assert.deepEqual(result.pullRequests, []);
  assert.match(result.retained.join("\n"), /abd\/34-one carries work that already merged/);
});

test("full cleanup adds remote branches and still-open unmerged pull requests", () => {
  const result = plan("full-cleanup");
  assert.deepEqual(result.remoteBranches.map((branch) => branch.name), [SESSION, "abd/35-two"]);
  assert.deepEqual(result.pullRequests.map((pullRequest) => pullRequest.number), [57, 60]);
});

test("a dirty checkout is never deleted", () => {
  const result = plan("full-cleanup", record(), observations({ workingTree: { branch: SESSION, dirtyPaths: ["src/a.ts"] } }));
  assert.equal(result.removeWorkspace, false);
  assert.match(result.retained.join("\n"), /uncommitted changes and is kept/);
});

test("an artifact that moved since the run recorded it is kept and reported", () => {
  const moved = observations({
    branches: [
      { name: SESSION, localSha: SHA("z"), remoteSha: SHA("z") },
      { name: "abd/35-two", localSha: SHA("c"), remoteSha: SHA("c") },
    ],
  });
  const result = plan("full-cleanup", record(), moved);
  assert.deepEqual(result.localBranches.map((branch) => branch.name), ["abd/35-two"]);
  assert.match(result.retained.join("\n"), new RegExp(`${SESSION} has moved since the run pushed it`));
  assert.match(result.retained.join("\n"), new RegExp(`origin/${SESSION} has moved since the run pushed it`));
});

test("a retargeted pull request is not one this run still owns", () => {
  const retargeted = observations({
    pullRequests: [{ number: 57, state: "open", head: "abd/35-two", base: "main", approvedByOther: false }],
  });
  const result = plan("full-cleanup", record(), retargeted);
  assert.deepEqual(result.pullRequests.map((pullRequest) => pullRequest.number), []);
  assert.match(result.retained.join("\n"), /pull request #57 was retargeted and is kept/);
});

test("cleanup never reopens an issue or reverts what merged, whichever behavior is chosen", () => {
  for (const behavior of ["local-cleanup", "full-cleanup"] as const) {
    const result = plan(behavior);
    assert.match(result.retained.join("\n"), /issues the run closed stay closed, and merged commits are never reverted/);
  }
});

test("the modal summary lists exactly what the boundary will do", () => {
  const summary = describeDiscard(plan("full-cleanup"));
  assert.match(summary, /Close this run's terminals\./);
  assert.match(summary, /Remove the run's own checkout\./);
  assert.match(summary, /Delete 2 local branch\(es\).*abd\/35-two/);
  assert.match(summary, /Delete 2 remote branch\(es\)/);
  assert.match(summary, /Close pull request\(s\) #57, #60\./);
  assert.match(summary, /Kept: /);
});
