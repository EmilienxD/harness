import assert from "node:assert/strict";
import test from "node:test";

import type { CandidateIssue } from "../src/domain/auto-run.js";
import {
  completedCount,
  landedIssues,
  planRun,
  remainingIssues,
  runSucceeded,
  withProgress,
  type AutoRunRecord,
  type FrozenIssue,
} from "../src/domain/run-plan.js";

function candidate(overrides: Partial<CandidateIssue> & { readonly number: number }): CandidateIssue {
  return {
    title: `Issue ${overrides.number}`,
    labels: ["[AI]-afk"],
    state: "open",
    openBlockedByNumbers: [],
    dependencyNumbers: [],
    createdAt: `2026-01-${String(overrides.number % 28 + 1).padStart(2, "0")}T00:00:00.000Z`,
    ...overrides,
  };
}

test("planning skips unclassified and closed work and orders by creation", () => {
  const plan = planRun([
    candidate({ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], createdAt: "2026-01-02T00:00:00.000Z" }),
    candidate({ number: 34, title: "Add retry backoff", createdAt: "2026-01-01T00:00:00.000Z" }),
    candidate({ number: 36, title: "Unlabelled", labels: [], createdAt: "2026-01-03T00:00:00.000Z" }),
    candidate({ number: 38, title: "Already done", state: "closed", createdAt: "2026-01-05T00:00:00.000Z" }),
  ]);
  assert.deepEqual(plan.issues.map((entry) => entry.number), [34, 35]);
  assert.deepEqual(plan.issues.map((entry) => entry.disposition), ["afk", "hitl"]);
  assert.deepEqual(plan.skipped, [
    { number: 36, reason: "unclassified: neither [AI]-afk nor [AI]-hitl" },
  ]);
});

test("an issue blocked by work this run will also do joins the plan behind it", () => {
  const plan = planRun([
    candidate({ number: 37, title: "Later", openBlockedByNumbers: [35], dependencyNumbers: [35], createdAt: "2026-01-04T00:00:00.000Z" }),
    candidate({ number: 35, title: "Migrate the queue", createdAt: "2026-01-02T00:00:00.000Z" }),
  ]);
  assert.deepEqual(plan.issues.map((entry) => entry.number), [35, 37]);
  assert.deepEqual(plan.issues.find((entry) => entry.number === 37)?.dependsOn, [35]);
  assert.deepEqual(plan.skipped, []);
});

test("an issue blocked by work outside the plan is excluded, and so is anything it strands", () => {
  const plan = planRun([
    // #36 is unclassified, so this run cannot address it.
    candidate({ number: 36, labels: [], createdAt: "2026-01-01T00:00:00.000Z" }),
    candidate({ number: 37, openBlockedByNumbers: [36], createdAt: "2026-01-02T00:00:00.000Z" }),
    // Blocked only by #37, which the line above has just excluded.
    candidate({ number: 38, openBlockedByNumbers: [37], createdAt: "2026-01-03T00:00:00.000Z" }),
    candidate({ number: 39, createdAt: "2026-01-04T00:00:00.000Z" }),
  ]);
  assert.deepEqual(plan.issues.map((entry) => entry.number), [39]);
  assert.deepEqual(plan.skipped, [
    { number: 36, reason: "unclassified: neither [AI]-afk nor [AI]-hitl" },
    { number: 37, reason: "blocked by open #36, which this run cannot address" },
    { number: 38, reason: "blocked by open #37, which this run cannot address" },
  ]);
});

test("a planned issue carries the difficulty its label rates it at, and nothing when unrated", () => {
  const plan = planRun([
    candidate({ number: 10, labels: ["[AI]-afk", "[AI]-routine-difficulty"], createdAt: "2026-01-01T00:00:00.000Z" }),
    candidate({ number: 11, labels: ["[AI]-afk"], createdAt: "2026-01-02T00:00:00.000Z" }),
    candidate({ number: 12, labels: ["[AI]-hitl", "[AI]-expert-difficulty"], createdAt: "2026-01-03T00:00:00.000Z" }),
  ]);
  assert.deepEqual(plan.issues.map((entry) => entry.difficulty), ["routine", undefined, "expert"]);
  // A difficulty label alone classifies nothing: it rates work the disposition
  // labels admit, and never admits work on its own.
  assert.deepEqual(planRun([candidate({ number: 13, labels: ["[AI]-expert-difficulty"] })]).issues, []);
});

test("[AI]-chrome configures one planned implementer without admitting work", () => {
  const plan = planRun([
    candidate({ number: 10, labels: ["[AI]-afk", "[ai]-CHROME"] }),
    candidate({ number: 11, labels: ["[AI]-hitl"] }),
  ]);
  assert.equal(plan.issues.find((issue) => issue.number === 10)?.chrome, true);
  assert.equal(plan.issues.find((issue) => issue.number === 11)?.chrome, undefined);
  assert.deepEqual(planRun([candidate({ number: 12, labels: ["[AI]-chrome"] })]).issues, []);
});

test("the plan is ordered by creation date, not by number, with ties on the lower number", () => {
  // The newer issue holds the lower number; filed later, numbered first is
  // impossible on GitHub, but a transferred issue reproduces exactly this.
  const plan = planRun([
    candidate({ number: 12, createdAt: "2026-03-01T00:00:00.000Z" }),
    candidate({ number: 91, createdAt: "2026-01-01T00:00:00.000Z" }),
    candidate({ number: 40, createdAt: "2026-02-01T00:00:00.000Z" }),
    candidate({ number: 39, createdAt: "2026-02-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(plan.issues.map((entry) => entry.number), [91, 39, 40, 12]);
});

test("dependency order wins over age while unrelated ready work stays oldest first", () => {
  const plan = planRun([
    candidate({ number: 10, createdAt: "2026-01-01T00:00:00.000Z", dependencyNumbers: [30] }),
    candidate({ number: 20, createdAt: "2026-01-02T00:00:00.000Z" }),
    candidate({ number: 30, createdAt: "2026-01-03T00:00:00.000Z" }),
    candidate({ number: 40, createdAt: "2026-01-04T00:00:00.000Z", dependencyNumbers: [10] }),
  ]);

  // #10 is oldest but waits for #30. Of the initially ready issues #20 is
  // older than #30; once #30 releases #10, #10 goes before unrelated #40.
  assert.deepEqual(plan.issues.map((entry) => entry.number), [20, 30, 10, 40]);
  assert.deepEqual(plan.dependencyCycles, []);
});

test("dependency cycles are detected, broken locally, and ordered deterministically", () => {
  const plan = planRun([
    candidate({ number: 10, createdAt: "2026-01-01T00:00:00.000Z", dependencyNumbers: [20, 30] }),
    candidate({ number: 20, createdAt: "2026-01-02T00:00:00.000Z", dependencyNumbers: [10, 30] }),
    candidate({ number: 30, createdAt: "2026-01-03T00:00:00.000Z" }),
  ]);

  // The external edge to #30 survives cycle breaking. Only #10 <-> #20 is
  // relaxed, then age is the tie-breaker inside that component.
  assert.deepEqual(plan.issues.map((entry) => entry.number), [30, 10, 20]);
  assert.deepEqual(plan.dependencyCycles, [[10, 20]]);
});

test("parent issues follow the same disposition rules as every other issue", () => {
  const plan = planRun([
    candidate({ number: 10, labels: ["planning"], dependencyNumbers: [13], createdAt: "2026-01-01T00:00:00.000Z" }),
    candidate({ number: 11, labels: [], dependencyNumbers: [13], createdAt: "2026-01-02T00:00:00.000Z" }),
    candidate({ number: 12, labels: ["[AI]-afk"], dependencyNumbers: [13], createdAt: "2026-01-03T00:00:00.000Z" }),
    candidate({ number: 13, createdAt: "2026-01-04T00:00:00.000Z" }),
  ]);
  assert.deepEqual(plan.issues.map((entry) => entry.number), [13, 12]);
  assert.deepEqual(plan.skipped, [
    { number: 10, reason: "unclassified: neither [AI]-afk nor [AI]-hitl" },
    { number: 11, reason: "unclassified: neither [AI]-afk nor [AI]-hitl" },
  ]);
});

test("unrelated labels do not override an issue's implementation disposition", () => {
  const plan = planRun([candidate({ number: 10, labels: ["planning", "[AI]-hitl"] })]);
  assert.equal(plan.issues[0]?.number, 10);
  assert.equal(plan.issues[0]?.disposition, "hitl");
  assert.deepEqual(plan.skipped, []);
});

test("hitl wins a contradictory label pair because only a human may close it", () => {
  const plan = planRun([candidate({ number: 40, title: "Both", labels: ["[AI]-afk", "[AI]-hitl"] })]);
  assert.equal(plan.issues[0]?.disposition, "hitl");
});

test("a plan freezes the title its branch is named from", () => {
  const plan = planRun([candidate({ number: 34, title: "Add retry backoff" })]);
  assert.deepEqual(plan.issues[0], {
    number: 34,
    title: "Add retry backoff",
    branch: "issue/34-add-retry-backoff",
    disposition: "afk",
    dependsOn: [],
  } satisfies FrozenIssue);
});

// --- progress ---------------------------------------------------------------

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
      issueContextDepth: 1,
      mergeStrategy: "squash",
      mergeRunPullRequest: false,
      pauseAfterHitl: false,
      pollSeconds: 30,
      worktree: { enabled: false, root: "", keep: false, setupTimeoutSeconds: 600 },
    },
    plan: [
      { number: 34, title: "One", branch: "issue/34-one", disposition: "afk", dependsOn: [] },
      { number: 35, title: "Two", branch: "issue/35-two", disposition: "hitl", dependsOn: [] },
    ],
    progress: { "34": { state: "pending" }, "35": { state: "pending" } },
    sessionBranch: "run/test",
    targetBranch: "main",
    branchShas: {},
    currentIssue: undefined,
    checkpoint: "planned",
    reviewedIssues: [],
    ...overrides,
  };
}

test("progress derives what is left, what is done, and what landed", () => {
  let current = record();
  assert.equal(completedCount(current), 0);
  assert.deepEqual(remainingIssues(current).map((issue) => issue.number), [34, 35]);

  current = withProgress(current, 34, { state: "done", result: "landed", prNumber: 56, issueClosed: true });
  current = withProgress(current, 35, { state: "done", result: "no-changes" });
  assert.equal(completedCount(current), 2);
  assert.deepEqual(remainingIssues(current), []);
  assert.deepEqual(landedIssues(current), [{ number: 34, title: "One", prNumber: 56 }]);
});

test("a run succeeds only once its own pull request carries what landed", () => {
  let current = record();
  current = withProgress(current, 34, { state: "done", result: "landed", prNumber: 56, issueClosed: true });
  current = withProgress(current, 35, { state: "done", result: "no-changes" });
  // Work landed on the session branch and nothing points at it yet.
  assert.equal(runSucceeded(current, false), false);

  const opened = { ...current, runPullRequest: 60 };
  assert.equal(runSucceeded(opened, false), true);
  // With automatic merge frozen on, an unmerged pull request is not success.
  const merging = { ...opened, settings: { ...opened.settings, mergeRunPullRequest: true } };
  assert.equal(runSucceeded(merging, false), false);
  assert.equal(runSucceeded(merging, true), true);
});

test("a plan whose every entry needed no change succeeds with no pull request at all", () => {
  let current = record();
  current = withProgress(current, 34, { state: "done", result: "no-changes" });
  current = withProgress(current, 35, { state: "done", result: "no-changes" });
  assert.equal(runSucceeded(current, false), true);
});
