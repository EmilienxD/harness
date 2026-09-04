import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRTY_RECOVERY_SENTENCE,
  hasTrustedDirtyWork,
  validateRun,
  type BranchObservation,
  type IssueObservation,
  type PullRequestObservation,
  type RunObservations,
} from "../src/domain/run-validation.js";
import type { AutoRunRecord, IssueProgress } from "../src/domain/run-plan.js";

const SESSION = "abd/run/test";
const SHA = (seed: string) => seed.repeat(40).slice(0, 40);

function record(overrides: Partial<AutoRunRecord> = {}): AutoRunRecord {
  return {
    version: 2,
    runId: "run_test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempt: 2,
    settings: {
      review: false,
      exploreBeforeImplement: false,
      recursiveIssueReferences: false,
      mergeStrategy: "squash",
      mergeRunPullRequest: false,
      pauseAfterHitl: false,
      pollSeconds: 30,
      worktree: { enabled: false, root: "", keep: false, setupTimeoutSeconds: 600 },
    },
    plan: [
      { number: 34, title: "Add retry backoff", branch: "abd/34-add-retry-backoff", disposition: "afk", difficulty: "basic", dependsOn: [] },
      { number: 35, title: "Migrate the queue", branch: "abd/35-migrate-the-queue", disposition: "hitl", dependsOn: [34] },
    ],
    progress: { "34": { state: "pending" }, "35": { state: "pending" } },
    sessionBranch: SESSION,
    targetBranch: "feature/wip",
    branchShas: { [SESSION]: SHA("a") },
    currentIssue: undefined,
    checkpoint: "session-branch-ready",
    reviewedIssues: [],
    ...overrides,
  };
}

function branch(name: string, sha: string | undefined): BranchObservation {
  return { name, localSha: sha, remoteSha: sha };
}

function issue(number: number, overrides: Partial<IssueObservation> = {}): IssueObservation {
  return {
    number,
    state: "open",
    disposition: number === 35 ? "hitl" : "afk",
    difficulty: number === 34 ? "basic" : undefined,
    chrome: false,
    openBlockedByNumbers: [],
    ...overrides,
  };
}

function observations(overrides: Partial<RunObservations> = {}): RunObservations {
  return {
    repositoryUsable: true,
    gitHubAuthenticated: true,
    targetBranchExists: true,
    workspacePresent: undefined,
    branches: [branch(SESSION, SHA("a")), branch("abd/34-add-retry-backoff", undefined), branch("abd/35-migrate-the-queue", undefined)],
    issues: [issue(34), issue(35, { openBlockedByNumbers: [34] })],
    pullRequests: [],
    workingTree: { branch: SESSION, dirtyPaths: [] },
    titles: {},
    ...overrides,
  };
}

/** The short reason, or `undefined` when the run may continue. */
function reason(current: AutoRunRecord, observed: RunObservations): string | undefined {
  const eligibility = validateRun(current, observed);
  return eligibility.state === "broken" ? eligibility.reason : undefined;
}

test("a run whose repository still matches its plan is resumable", () => {
  assert.deepEqual(validateRun(record(), observations()), { state: "resumable" });
});

test("infrastructure that is gone is reported before anything else", () => {
  assert.match(reason(record(), observations({ repositoryUsable: false })) ?? "", /no longer a usable git repository/);
  assert.match(reason(record(), observations({ gitHubAuthenticated: false })) ?? "", /can no longer authenticate/);
});

test("the branch the run started from must still exist, but may have advanced", () => {
  assert.match(reason(record(), observations({ targetBranchExists: false })) ?? "", /feature\/wip.*no longer exists/);
  // The final pull request already owns reconciling with whatever landed there,
  // so the user's own branch moving is ordinary rather than a mismatch.
  assert.equal(reason(record(), observations()), undefined);
});

test("a run-owned branch that moved fails the whole run", () => {
  const moved = observations({ branches: [{ name: SESSION, localSha: SHA("b"), remoteSha: SHA("a") }] });
  assert.match(reason(record(), moved) ?? "", new RegExp(`${SESSION} has moved`));

  const forcePushed = observations({ branches: [{ name: SESSION, localSha: SHA("a"), remoteSha: SHA("b") }] });
  assert.match(reason(record(), forcePushed) ?? "", new RegExp(`origin/${SESSION} has moved`));

  const deleted = observations({ branches: [branch(SESSION, undefined)] });
  assert.match(reason(record(), deleted) ?? "", new RegExp(`${SESSION} no longer exists`));
});

test("a branch belonging to work the run has not started is a branch it did not create", () => {
  const squatted = observations({
    branches: [branch(SESSION, SHA("a")), branch("abd/34-add-retry-backoff", SHA("c"))],
  });
  assert.match(reason(record(), squatted) ?? "", /abd\/34-add-retry-backoff already exists but this run did not create it/);
});

test("the current issue's branch is required only once the run recorded a SHA for it", () => {
  const started = record({
    currentIssue: 34,
    checkpoint: "issue",
    progress: { "34": { state: "current", phase: "branch" }, "35": { state: "pending" } },
  });
  // Before the branch phase reaches its postcondition there is nothing to require.
  assert.equal(reason(started, observations()), undefined);

  const committed = record({
    ...started,
    branchShas: { [SESSION]: SHA("a"), "abd/34-add-retry-backoff": SHA("c") },
  });
  assert.match(reason(committed, observations()) ?? "", /abd\/34-add-retry-backoff no longer exists/);
});

test("a plan issue that closed, vanished, or changed classification fails the run", () => {
  assert.match(reason(record(), observations({ issues: [issue(34), issue(35, { state: "missing" })] })) ?? "", /#35 no longer exists/);
  assert.match(reason(record(), observations({ issues: [issue(34), issue(35, { state: "closed" })] })) ?? "", /#35 was closed while the run still had it queued/);
  assert.match(reason(record(), observations({ issues: [issue(34, { disposition: "hitl" }), issue(35)] })) ?? "", /#34 is now hitl rather than afk/);
  assert.match(reason(record(), observations({ issues: [issue(34, { disposition: "unclassified" }), issue(35)] })) ?? "", /#34 is now unclassified/);
  assert.match(reason(record(), observations({ issues: [issue(34, { difficulty: "expert" }), issue(35)] })) ?? "", /#34 has a different difficulty/);
});

test("adding or removing [AI]-chrome after planning breaks recovery", () => {
  assert.match(reason(record(), observations({ issues: [issue(34, { chrome: true }), issue(35)] })) ?? "", /#34 now has the \[AI\]-chrome label/);
  const frozenWithChrome = record({ plan: [{ ...record().plan[0]!, chrome: true }, record().plan[1]!] });
  assert.match(reason(frozenWithChrome, observations()) ?? "", /#34 no longer has the \[AI\]-chrome label/);
});

test("a title change never invalidates a plan", () => {
  // The plan froze the title it uses for branches and commits; an issue somebody
  // clarified in prose is still the same work.
  assert.equal(reason(record(), observations({ titles: { "34": "Add retry backoff, with jitter" } })), undefined);
});

test("dependency relationships remain exact while blockers are open", () => {
  // #35 froze `dependsOn: [34]`. Observing it still blocked by #34 is expected.
  assert.equal(reason(record(), observations({ issues: [issue(34), issue(35, { openBlockedByNumbers: [34] })] })), undefined);
  const removedEdge = observations({ issues: [issue(34), issue(35)] });
  assert.match(reason(record(), removedEdge) ?? "", /no longer blocked by #34/);

  const newBlocker = observations({ issues: [issue(34), issue(35, { openBlockedByNumbers: [99] })] });
  assert.match(reason(record(), newBlocker) ?? "", /#35 is now blocked by #99, which the run did not plan for/);
});

test("a dependency edge that reaches outside the plan fails, because the plan closed over its own", () => {
  const external = record({
    plan: [
      record().plan[0]!,
      { ...record().plan[1]!, dependsOn: [99] },
    ],
  });
  const observed = observations({ issues: [issue(34), issue(35, { openBlockedByNumbers: [99] })] });
  assert.match(reason(external, observed) ?? "", /#35 depends on #99, which is outside this run/);
});

// --- pull requests ----------------------------------------------------------

function pullRequest(overrides: Partial<PullRequestObservation> & { readonly number: number }): PullRequestObservation {
  return { state: "open", head: "abd/34-add-retry-backoff", base: SESSION, approvedByOther: false, ...overrides };
}

function working(progress: IssueProgress, number = 34): AutoRunRecord {
  return record({
    currentIssue: number,
    checkpoint: "issue",
    branchShas: { [SESSION]: SHA("a"), [`abd/${number}-${number === 34 ? "add-retry-backoff" : "migrate-the-queue"}`]: SHA("c") },
    progress: { "34": { state: "pending" }, "35": { state: "pending" }, [String(number)]: progress },
  });
}

const withIssueBranch = (number = 34, name = "abd/34-add-retry-backoff") => observations({
  branches: [branch(SESSION, SHA("a")), branch(name, SHA("c"))],
});

test("a recorded pull request must still be the pull request the record described", () => {
  const current = working({ state: "current", phase: "await-approval", prNumber: 56 });
  const base = withIssueBranch();

  assert.match(reason(current, { ...base, pullRequests: [] }) ?? "", /#56 no longer exists/);
  assert.match(reason(current, { ...base, pullRequests: [pullRequest({ number: 56, head: "somebody/else" })] }) ?? "", /#56 no longer comes from abd\/34-add-retry-backoff/);
  assert.match(reason(current, { ...base, pullRequests: [pullRequest({ number: 56, base: "main" })] }) ?? "", /#56 no longer targets abd\/run\/test/);
  assert.match(reason(current, { ...base, pullRequests: [pullRequest({ number: 56, state: "closed" })] }) ?? "", /#56 for issue #34 was closed without merging/);
});

test("an afk pull request merged by somebody else fails the run", () => {
  // The run owns these merges. One it did not perform means the record no longer
  // describes what happened, and the next step would act on that.
  const current = working({ state: "current", phase: "merge", prNumber: 56 });
  const merged = { ...withIssueBranch(), pullRequests: [pullRequest({ number: 56, state: "merged" })] };
  assert.match(reason(current, merged) ?? "", /#56 for issue #34 was merged outside the run/);

  // Unless the journal says the run had begun exactly that merge when it died.
  const journalled = { ...current, pendingAction: { kind: "merge-issue-pr" as const, prNumber: 56, head: "abd/34-add-retry-backoff", base: SESSION, headSha: SHA("c"), baseSha: SHA("a") } };
  const exactMerge = {
    ...merged,
    branches: [branch(SESSION, SHA("d")), branch("abd/34-add-retry-backoff", SHA("c"))],
    pullRequests: [pullRequest({ number: 56, state: "merged", headSha: SHA("c"), mergeCommitSha: SHA("d") })],
  };
  assert.equal(reason(journalled, exactMerge), undefined);
});

test("a journalled merge explains the CLI having deleted its issue branch", () => {
  const current = record({
    currentIssue: 34,
    checkpoint: "issue",
    progress: { "34": { state: "current", phase: "merge", prNumber: 56 }, "35": { state: "pending" } },
    branchShas: { [SESSION]: SHA("a"), "abd/34-add-retry-backoff": SHA("c") },
    pendingAction: {
      kind: "merge-issue-pr",
      prNumber: 56,
      head: "abd/34-add-retry-backoff",
      base: SESSION,
      headSha: SHA("c"),
      baseSha: SHA("a"),
    },
  });
  const observed = observations({
    branches: [branch(SESSION, SHA("d")), branch("abd/34-add-retry-backoff", undefined)],
    pullRequests: [pullRequest({ number: 56, state: "merged", headSha: SHA("c"), mergeCommitSha: SHA("d") })],
  });
  assert.equal(reason(current, observed), undefined);
});

test("a hitl pull request the user merged or another account approved is allowed", () => {
  // These two are the whole point of the hitl disposition.
  const current = working({ state: "current", phase: "await-approval", prNumber: 57 }, 35);
  const observed = observations({ branches: [branch(SESSION, SHA("a")), branch("abd/35-migrate-the-queue", SHA("c"))] });

  const mergedByUser = {
    ...observed,
    branches: [branch(SESSION, SHA("d")), branch("abd/35-migrate-the-queue", SHA("c"))],
    pullRequests: [pullRequest({
      number: 57,
      head: "abd/35-migrate-the-queue",
      state: "merged",
      headSha: SHA("c"),
      mergeCommitSha: SHA("d"),
    })],
  };
  assert.equal(reason(current, mergedByUser), undefined);

  const wrongHead = {
    ...mergedByUser,
    pullRequests: [pullRequest({
      number: 57,
      head: "abd/35-migrate-the-queue",
      state: "merged",
      headSha: SHA("e"),
      mergeCommitSha: SHA("d"),
    })],
  };
  assert.match(reason(current, wrongHead) ?? "", new RegExp(`${SESSION} has moved`));

  const movedAgain = {
    ...mergedByUser,
    branches: [branch(SESSION, SHA("e")), branch("abd/35-migrate-the-queue", SHA("c"))],
  };
  assert.match(reason(current, movedAgain) ?? "", new RegExp(`${SESSION} has moved`));

  const approved = { ...observed, pullRequests: [pullRequest({ number: 57, head: "abd/35-migrate-the-queue", approvedByOther: true })] };
  assert.equal(reason(current, approved), undefined);
});

test("a landed issue's pull request must still be merged, and its closure must match what aboard recorded", () => {
  const landed = record({
    progress: { "34": { state: "done", result: "landed", prNumber: 56, issueClosed: true }, "35": { state: "pending" } },
  });
  const observed = observations({
    issues: [issue(34, { state: "closed" }), issue(35)],
    pullRequests: [pullRequest({ number: 56, state: "merged" })],
  });
  assert.equal(reason(landed, observed), undefined);

  assert.match(reason(landed, { ...observed, pullRequests: [pullRequest({ number: 56, state: "open" })] }) ?? "", /#56 for issue #34 is no longer merged/);
  assert.match(reason(landed, { ...observed, issues: [issue(34), issue(35, { openBlockedByNumbers: [34] })] }) ?? "", /#34 was reopened after the run closed it/);

  // A close that failed was reported and survived; either state is legitimate.
  const notClosed = record({
    progress: { "34": { state: "done", result: "landed", prNumber: 56, issueClosed: false }, "35": { state: "pending" } },
  });
  assert.equal(reason(notClosed, { ...observed, issues: [issue(34), issue(35, { openBlockedByNumbers: [34] })] }), undefined);
});

test("the run's own pull request may not be merged or closed by anybody else", () => {
  const concluding = record({ runPullRequest: 60, checkpoint: "concluding" });
  const observed = observations({ pullRequests: [pullRequest({ number: 60, head: SESSION, base: "feature/wip" })] });
  assert.equal(reason(concluding, observed), undefined);

  const externallyMerged = { ...observed, pullRequests: [pullRequest({ number: 60, head: SESSION, base: "feature/wip", state: "merged" })] };
  assert.match(reason(concluding, externallyMerged) ?? "", /run's pull request #60 was merged outside the run/);

  const closed = { ...observed, pullRequests: [pullRequest({ number: 60, head: SESSION, base: "feature/wip", state: "closed" })] };
  assert.match(reason(concluding, closed) ?? "", /run's pull request #60 was closed/);
});

// --- working tree and workspace ---------------------------------------------

test("uncommitted work is trusted only on the branch the run's current issue belongs to", () => {
  const current = working({ state: "current", phase: "implement" });
  const observed = withIssueBranch();

  const onIssueBranch = { ...observed, workingTree: { branch: "abd/34-add-retry-backoff", dirtyPaths: ["src/a.ts"] } };
  assert.equal(reason(current, onIssueBranch), undefined);
  assert.equal(hasTrustedDirtyWork(current, onIssueBranch), true);

  const elsewhere = { ...observed, workingTree: { branch: "feature/wip", dirtyPaths: ["src/a.ts"] } };
  assert.match(reason(current, elsewhere) ?? "", /uncommitted changes on feature\/wip, which is not the branch this run is working/);
  assert.equal(hasTrustedDirtyWork(current, elsewhere), false);

  // With no current issue there is no branch that could own the work.
  assert.match(reason(record(), { ...observations(), workingTree: { branch: SESSION, dirtyPaths: ["src/a.ts"] } }) ?? "", /not the branch this run is working/);
});

test("the run's own checkout is required only after its creation was checkpointed", () => {
  const before = record({ settings: { ...record().settings, workspaceRoot: "C:/checkouts/run/repo" } });
  // A run that died while preparing one simply retries.
  assert.equal(reason(before, observations({ workspacePresent: false })), undefined);

  const after = { ...before, workspaceCreated: true as const };
  assert.match(reason(after, observations({ workspacePresent: false })) ?? "", /run's own checkout is gone/);
  assert.equal(reason(after, observations({ workspacePresent: true })), undefined);
});

test("the recovery sentence is exactly one sentence about the edits, not about the crash", () => {
  assert.equal(DIRTY_RECOVERY_SENTENCE.split(/(?<=\.)\s/u).length, 1);
  assert.match(DIRTY_RECOVERY_SENTENCE, /review them critically/);
  assert.doesNotMatch(DIRTY_RECOVERY_SENTENCE, /crash|interrupt|resume/i);
});
