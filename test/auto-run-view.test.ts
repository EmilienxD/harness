import assert from "node:assert/strict";
import test from "node:test";

import { AutoRunForecastController, AutoRunTreeModel, autoRunCard, cardPullRequest, type AutoRunForecast, type AutoRunPreview, type AutoRunViewSources } from "../src/vscode/auto-run.js";
import type { AutoRunState } from "../src/auto/engine.js";
import type { AutoRunDryRunResult } from "../src/domain/auto-run.js";
import type { AutoRunRecord, PersistedAutoRunRecord, RecoveryEligibility } from "../src/domain/run-plan.js";

const SESSION = "aboard/run/test";

function record(overrides: Partial<AutoRunRecord> = {}): AutoRunRecord {
  return {
    version: 2,
    runId: "run_test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempt: 1,
    settings: {
      review: false,
      recursiveIssueReferences: false,
      mergeStrategy: "squash",
      mergeRunPullRequest: false,
      pauseAfterHitl: false,
      pollSeconds: 30,
      worktree: { enabled: false, root: "", keep: false, setupTimeoutSeconds: 600 },
    },
    plan: [
      { number: 34, title: "Add retry backoff", branch: "aboard/34-add-retry-backoff", disposition: "afk", dependsOn: [] },
      { number: 35, title: "Migrate the queue", branch: "aboard/35-migrate-the-queue", disposition: "hitl", dependsOn: [34] },
      { number: 36, title: "Trim the cache", branch: "aboard/36-trim-the-cache", disposition: "afk", dependsOn: [] },
    ],
    progress: {
      "34": { state: "done", result: "landed", prNumber: 56, issueClosed: true },
      "35": { state: "current", phase: "await-approval", prNumber: 57 },
      "36": { state: "pending" },
    },
    sessionBranch: SESSION,
    targetBranch: "feature/wip",
    branchShas: {},
    currentIssue: 35,
    checkpoint: "issue",
    reviewedIssues: [],
    ...overrides,
  };
}

function state(overrides: Partial<AutoRunState> = {}): AutoRunState {
  return {
    runId: "run_test",
    phase: "await-approval",
    currentIssue: 35,
    completedCount: 1,
    totalCount: 3,
    waiting: false,
    currentPullRequest: 57,
    ...overrides,
  };
}

function sources(overrides: {
  readonly state?: AutoRunState | undefined;
  readonly starting?: boolean;
  readonly forecast?: AutoRunForecast;
  readonly persisted?: PersistedAutoRunRecord | undefined;
  readonly eligibility?: RecoveryEligibility | undefined;
  readonly titles?: Readonly<Record<string, string>>;
} = {}): AutoRunViewSources {
  return {
    starting: () => overrides.starting ?? false,
    forecast: () => overrides.forecast ?? { preview: undefined, checking: false, checkedAt: undefined, error: undefined },
    state: () => overrides.state,
    persisted: () => overrides.persisted,
    eligibility: () => overrides.eligibility,
    titles: () => overrides.titles ?? {},
  };
}

function preview(overrides: Partial<AutoRunPreview> = {}): AutoRunPreview {
  return {
    dryRun: true,
    inspected: true,
    ready: true,
    blockers: [],
    reviewMode: false,
    pauseAfterHitl: false,
    isolatedWorkspace: false,
    keepsWorkspace: false,
    sessionBranch: "aboard/run/<run-id>",
    sessionBase: "feature/wip",
    mergesItsOwnPullRequest: false,
    issues: record().plan,
    skipped: [],
    dependencyCycles: [],
    ...overrides,
  };
}

function forecast(result: AutoRunPreview | undefined, overrides: Partial<AutoRunForecast> = {}): AutoRunForecast {
  return {
    preview: result,
    checking: false,
    checkedAt: "2026-01-01T00:00:00.000Z",
    error: undefined,
    ...overrides,
  };
}

const card = (input: Parameters<typeof sources>[0]) => autoRunCard(sources(input));
const rootItem = (input: Parameters<typeof sources>[0]) => {
  const model = new AutoRunTreeModel(sources(input));
  const root = model.roots()[0]!;
  return { model, root, item: model.item(root) };
};

test("no record offers the one way to start a run", () => {
  const { item } = rootItem({});
  assert.equal(card({}).kind, "idle");
  assert.equal(item.contextValue, "aboard.autoRun.idle");
  assert.equal(item.collapsible, false);
});

test("clicking Start immediately replaces the idle action with GitHub loading feedback", () => {
  const { item } = rootItem({ starting: true });
  assert.equal(card({ starting: true }).kind, "starting");
  assert.equal(item.label, "Starting auto-run");
  assert.equal(item.description, "loading issues from GitHub…");
  assert.equal(item.icon, "loading~spin");
  assert.equal(item.contextValue, "aboard.autoRun.starting");
  assert.equal(item.collapsible, false);
});

test("the live forecast shows loading feedback, then the planned issues in execution order", () => {
  const loading = rootItem({ forecast: forecast(undefined, { checking: true }) });
  assert.equal(loading.item.label, "Checking next auto-run");
  assert.equal(loading.item.icon, "loading~spin");

  const result = preview();
  const live = forecast(result);
  const { model, root, item } = rootItem({ forecast: live });
  assert.equal(card({ forecast: live }).kind, "forecast");
  assert.equal(item.description, "3 issues queued");
  assert.equal(item.contextValue, "aboard.autoRun.forecast");
  assert.equal(item.collapsible, true);
  const rows = model.children(root).map((node) => model.item(node));
  assert.deepEqual(rows.map((row) => row.label), [
    "#34 Add retry backoff",
    "#35 Migrate the queue",
    "#36 Trim the cache",
  ]);
  assert.deepEqual(rows.map((row) => row.description), ["1/3 · afk", "2/3 · hitl", "3/3 · afk"]);
});

test("a blocked forecast explains why the run cannot start", () => {
  const result = preview({ ready: false, blockers: ["the working tree is not clean: src/a.ts"], issues: [] });
  const { item } = rootItem({ forecast: forecast(result) });
  assert.equal(item.description, "cannot start · 1 blocker");
  assert.equal(item.icon, "warning");
  assert.match(item.tooltip, /Cannot start: the working tree is not clean/);
  assert.equal(item.collapsible, false);
});

test("a refresh keeps the last successful issue list visible", () => {
  const result = preview();
  const { item, model, root } = rootItem({ forecast: forecast(result, { checking: true }) });
  assert.equal(item.description, "3 issues queued · refreshing…");
  assert.equal(item.icon, "sync~spin");
  assert.equal(model.children(root).length, 3);
});

test("a failed refresh keeps the last result and reports that it is stale", () => {
  const result = preview();
  const { item } = rootItem({ forecast: forecast(result, { error: "GitHub is unavailable" }) });
  assert.equal(item.description, "3 issues queued");
  assert.match(item.tooltip, /Last refresh failed: GitHub is unavailable/);

  const unavailable = rootItem({ forecast: forecast(undefined, { checkedAt: undefined, error: "not authenticated" }) });
  assert.equal(unavailable.item.contextValue, "aboard.autoRun.forecastUnavailable");
  assert.match(unavailable.item.tooltip, /Use Check Now to try again/);
});

test("forecast refreshes are single-flight and invalidation rejects a stale result", async () => {
  let resolve: ((result: AutoRunDryRunResult) => void) | undefined;
  let calls = 0;
  const changes: AutoRunForecast[] = [];
  const controller = new AutoRunForecastController(
    () => changes.push(controller.snapshot()),
    () => new Date("2026-01-01T00:00:00.000Z"),
  );
  const inspect = () => {
    calls += 1;
    return new Promise<AutoRunDryRunResult>((done) => { resolve = done; });
  };

  const first = controller.refresh(inspect);
  assert.equal(controller.refresh(inspect), first);
  assert.equal(calls, 1);
  assert.equal(controller.snapshot().checking, true);

  controller.invalidate();
  resolve?.(preview());
  await first;

  assert.equal(controller.snapshot().preview, undefined);
  assert.equal(changes.at(-1)?.checking, true, "the invalidated result emits no stale completion");
});

test("a forecast refresh failure retains the last successful result", async () => {
  const controller = new AutoRunForecastController(() => undefined, () => new Date("2026-01-01T00:00:00.000Z"));
  await controller.refresh(async () => preview());
  await controller.refresh(async () => { throw new Error("GitHub is unavailable"); });

  assert.equal(controller.snapshot().preview?.issues.length, 3);
  assert.equal(controller.snapshot().error, "GitHub is unavailable");
  assert.equal(controller.snapshot().checkedAt, "2026-01-01T00:00:00.000Z");
});

test("an unresolved record suppresses Start, whatever state it is in", () => {
  // Two runs competing for the same branches is the failure this prevents.
  for (const eligibility of [undefined, { state: "checking" }, { state: "resumable" }, { state: "broken", reason: "x" }] as const) {
    assert.notEqual(card({ persisted: record(), eligibility }).kind, "idle");
  }
});

test("a live run outranks any recovery question about its own record", () => {
  const active = card({ persisted: record(), state: state(), eligibility: { state: "broken", reason: "mid-phase" } });
  assert.equal(active.kind, "active");
  const { item } = rootItem({ persisted: record(), state: state() });
  assert.equal(item.contextValue, "aboard.autoRun.active");
  assert.match(item.description, /await-approval · issue #35 · 1\/3/);
});

test("a run waiting for the user is its own state, with its own actions", () => {
  const { item } = rootItem({ persisted: record(), state: state({ waiting: true }) });
  assert.equal(item.contextValue, "aboard.autoRun.waiting");
  assert.match(item.description, /waiting for you · issue #35/);
  assert.match(item.tooltip, /Merge the pull request, or approve it from another account/);
});

test("Resume is absent while eligibility is still being computed", () => {
  for (const eligibility of [undefined, { state: "checking" } as const]) {
    const { item } = rootItem({ persisted: record(), eligibility });
    assert.equal(item.contextValue, "aboard.autoRun.checking");
    assert.match(item.description, /checking whether it can be resumed/);
  }
});

test("a resumable run names how it ended and how far it got", () => {
  const cancelled = rootItem({ persisted: record({ outcome: { kind: "cancelled" } }), eligibility: { state: "resumable" } });
  assert.equal(cancelled.item.contextValue, "aboard.autoRun.recoverable");
  assert.match(cancelled.item.description, /stopped by you · 1\/3 done/);

  const failed = rootItem({ persisted: record({ outcome: { kind: "failed", reason: "push rejected" } }), eligibility: { state: "resumable" } });
  assert.match(failed.item.description, /failed — push rejected/);

  // A record with no outcome is one whose host disappeared under it.
  const lost = rootItem({ persisted: record(), eligibility: { state: "resumable" } });
  assert.match(lost.item.description, /^interrupted/);
});

test("a broken run shows the short reason and nothing to resume with", () => {
  const { item } = rootItem({ persisted: record(), eligibility: { state: "broken", reason: "aboard/run/test has moved since the run last pushed it" } });
  assert.equal(item.contextValue, "aboard.autoRun.broken");
  assert.match(item.description, /cannot be resumed — aboard\/run\/test has moved/);
  assert.match(item.tooltip, /Nothing has been rolled back/);
});

test("a version-1 record is broken with the one reason it can have, and no plan to show", () => {
  const { item, model, root } = rootItem({ persisted: { version: 1, runId: "run_old", startedAt: "2026-01-01T00:00:00.000Z" } });
  assert.equal(item.contextValue, "aboard.autoRun.unsupported");
  assert.match(item.description, /predates fixed-plan recovery/);
  assert.equal(item.collapsible, false);
  assert.deepEqual(model.children(root), []);
});

test("the whole frozen plan renders in its immutable order, whatever its progress", () => {
  const { model, root } = rootItem({ persisted: record(), eligibility: { state: "resumable" } });
  const rows = model.children(root).map((node) => model.item(node));
  assert.deepEqual(rows.map((row) => row.label), [
    "#34 Add retry backoff",
    "#35 Migrate the queue",
    "#36 Trim the cache",
  ]);
  assert.deepEqual(rows.map((row) => row.description), ["done · PR #56", "current · await-approval", "pending"]);
  assert.deepEqual(rows.map((row) => row.contextValue), [
    "aboard.autoRun.issue.done",
    "aboard.autoRun.issue.current",
    "aboard.autoRun.issue.pending",
  ]);
  // Clicking a row opens the issue on GitHub.
  assert.deepEqual(rows[0]?.command, { command: "aboard.openIssue", title: "Open Issue", arguments: [34] });
});

test("an [AI]-chrome issue says so in its frozen plan row", () => {
  const withChrome = record({ plan: [{ ...record().plan[0]!, chrome: true }, ...record().plan.slice(1)] });
  const model = new AutoRunTreeModel(sources({ persisted: withChrome, eligibility: { state: "resumable" } }));
  const first = model.children(model.roots()[0]!)[0];
  assert.equal(first?.kind, "issue");
  if (first?.kind !== "issue") return;
  assert.match(model.item(first).tooltip, /Claude in Chrome: enabled by \[AI\]-chrome/);
});

test("a done row says whether it landed or correctly changed nothing", () => {
  const unchanged = record({ progress: { ...record().progress, "34": { state: "done", result: "no-changes" } } });
  const { model, root } = rootItem({ persisted: unchanged, eligibility: { state: "resumable" } });
  assert.equal(model.item(model.children(root)[0]!).description, "done · no changes needed");
});

test("a row shows the latest observed title while the plan keeps the one it froze", () => {
  const { model, root } = rootItem({
    persisted: record(),
    eligibility: { state: "resumable" },
    titles: { "34": "Add retry backoff, with jitter" },
  });
  const rows = model.children(root);
  assert.equal(model.item(rows[0]!).label, "#34 Add retry backoff, with jitter");
  // The frozen title is what branches and commits are named from, untouched.
  assert.equal(rows[0]!.kind === "issue" ? rows[0]!.issue.branch : "", "aboard/34-add-retry-backoff");
  assert.equal(rows[0]!.kind === "issue" ? rows[0]!.issue.title : "", "Add retry backoff");
});

test("the tooltip names where the work goes and what the run froze", () => {
  const isolated = record({ settings: { ...record().settings, workspaceRoot: "C:/checkouts/run_test/repo", review: true } });
  const { item } = rootItem({ persisted: isolated, state: state() });
  assert.match(item.tooltip, /Session branch: aboard\/run\/test/);
  assert.match(item.tooltip, /Target branch: feature\/wip/);
  assert.match(item.tooltip, /Working in C:\/checkouts\/run_test\/repo/);
  assert.match(item.tooltip, /Review on/);

  const inPlace = rootItem({ persisted: record(), state: state() });
  assert.match(inPlace.item.tooltip, /Working in your checkout/);
});

test("the pull request an action opens is the current one, or the run's when there is none", () => {
  assert.equal(cardPullRequest(card({ persisted: record(), state: state() }), state()), 57);
  const concluded = record({ currentIssue: undefined, runPullRequest: 60 });
  assert.equal(cardPullRequest(card({ persisted: concluded, eligibility: { state: "resumable" } }), undefined), 60);
  assert.equal(cardPullRequest(card({}), undefined), undefined);
});
