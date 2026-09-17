import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { FleetRegistry } from "../../src/domain/fleet.js";
import { ActivityRecorder } from "../../src/runtime/activity-recorder.js";
import type { ActivityDto } from "../../src/domain/activity.js";
import { FileActivityStore, FileAutoRunStore, PersistOnChange, parseAutoRunRecord, FileFleetStore } from "../../src/runtime/persistence.js";
import type { AutoRunRecord } from "../../src/domain/run-plan.js";
import { combineHandlers } from "../../src/bridge/router.js";
import type { AuthenticatedBridgeRequest } from "../../src/bridge/protocol.js";
import { RuntimeAdmission, RuntimeStartup } from "../../src/runtime/admission.js";
import { RuntimeLayout } from "../../src/runtime/layout.js";

test("runtime admission closes immediately and drains admitted operations before reset cleanup", async () => {
  const admission = new RuntimeAdmission(true);
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const admitted = admission.run(async () => { await deferred; });
  let drained = false;
  const closing = admission.close().then(() => { drained = true; });

  await assert.rejects(admission.run(async () => undefined), /not initialized/);
  assert.equal(drained, false);
  release();
  await admitted;
  await closing;
  assert.equal(drained, true);

  admission.open();
  await admission.run(async () => undefined);
});

test("runtime startup is single-flight and reset drains endpoint publication", async () => {
  const admission = new RuntimeAdmission(true);
  const startup = new RuntimeStartup(admission);
  let starts = 0;
  let release!: () => void;
  const publishing = new Promise<void>((resolve) => { release = resolve; });
  const operation = async () => { starts += 1; await publishing; };
  const first = startup.run(operation);
  const second = startup.run(operation);
  assert.equal(first, second);
  assert.equal(starts, 1);
  let resetFinished = false;
  const reset = admission.close().then(() => { resetFinished = true; });
  assert.equal(resetFinished, false);
  release();
  await Promise.all([first, reset]);
  assert.equal(resetFinished, true);
});

test("fleet runtime metadata saves atomically and ignores corrupt recovery data", async () => {
  const root = await mkdtemp(join(tmpdir(), "abd-runtime-"));
  const store = new FileFleetStore(root);
  const fleet = new FleetRegistry();
  await store.save(fleet.toPersistenceDto());
  assert.deepEqual(await store.load(), fleet.toPersistenceDto());
  const path = join(root, "state", "fleet.json");
  await writeFile(path, "truncated", "utf8");
  assert.equal(await store.load(), undefined);
  assert.equal((await readFile(path, "utf8")), "truncated");
});

test("persistence drains queued writes and performs a final save on disposal", async () => {
  let listener: (() => void) | undefined;
  let saves = 0;
  const persistence = new PersistOnChange((registered) => { listener = registered; return { dispose() { listener = undefined; } }; }, async () => { saves += 1; }, () => assert.fail("save failed"));
  listener?.(); listener?.();
  await persistence.dispose();
  assert.equal(saves, 3);
  assert.equal(listener, undefined);
});

test("removing private runtime state drops the activity cache instead of resurrecting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-activity-"));
  let initialized = true;
  let changes = 0;
  const admission = new RuntimeAdmission(true);
  const recorder = new ActivityRecorder({
    store: new FileActivityStore(root, admission),
    admission: () => initialized,
    now: () => new Date("2026-08-29T10:00:00.000Z"),
    log: () => undefined,
    onDidChange: () => { changes += 1; },
  });
  recorder.recordRun({ runId: "run_before", attempt: 1, outcome: "succeeded", issueNumbers: [7] });
  await recorder.settle();
  assert.equal(recorder.entries().length, 1);

  // Project reset closes admission, then removes private runtime state.
  initialized = false;
  await admission.close();
  await rm(root, { recursive: true, force: true });
  const before = changes;
  await recorder.reset();
  assert.deepEqual(recorder.entries(), []);
  assert.equal(changes, before + 1);
  assert.equal(existsSync(root), false);

  // Initializing again starts from the store on disk, not from this process.
  initialized = true;
  admission.open();
  await recorder.load();
  assert.deepEqual(recorder.entries(), []);
  recorder.recordRun({ runId: "run_after", attempt: 1, outcome: "started" });
  await recorder.settle();
  const persisted = JSON.parse(await readFile(join(root, "state", "activity.json"), "utf8")) as ActivityDto;
  assert.deepEqual(persisted.entries.map((entry) => entry.kind === "run" ? entry.runId : entry.kind), ["run_after"]);
});

/** A complete Auto Run record, so each test states only what it is about. */
function fixedPlanRecord(): AutoRunRecord {
  return {
    version: 1,
    runId: "run_return",
    startedAt: "2026-07-31T09:12:04.221Z",
    updatedAt: "2026-07-31T10:00:00.000Z",
    attempt: 2,
    settings: {
      branchMode: "per-issue",
      review: true,
      exploreBeforeAddress: true,
      issueContextDepth: 2,
      mergeStrategy: "merge",
      mergeRunPullRequest: true,
      worktree: { enabled: true, root: "C:/checkouts", keep: false, setupTimeoutSeconds: 900 },
      workspaceRoot: "C:/checkouts/run_return/aboard",
      permanentPrompt: "run browser tests",
      additionalGuideline: "keep fixtures small",
    },
    plan: [
      { number: 34, title: "Add retry backoff", branch: "issue/34-add-retry-backoff", disposition: "afk", difficulty: "advanced", chrome: true, dependsOn: [] },
      { number: 35, title: "Migrate the queue", branch: "issue/35-migrate-the-queue", disposition: "hitl", dependsOn: [34] },
    ],
    progress: {
      "34": { state: "done", result: "landed", prNumber: 56, issueClosed: true, beforeSha: "8".repeat(40), implementationSha: "9".repeat(40) },
      "35": { state: "current", phase: "await-commit", beforeSha: "a".repeat(40), addressCommitSha: "b".repeat(40), resetCompleted: true, hitlReviewCompleted: true, expectedBranch: "issue/35-migrate-the-queue" },
    },
    sessionBranch: "run/return",
    targetBranch: "feature/wip",
    targetHeadSha: "c".repeat(40),
    unpublishedTargetCommits: 2,
    branchShas: { "run/return": "a".repeat(40), "issue/35-migrate-the-queue": "b".repeat(40) },
    currentIssue: 35,
    checkpoint: "issue",
    runPullRequest: 60,
    reviewedIssues: [35],
    pendingAction: { kind: "merge-issue-pr", prNumber: 57, head: "issue/35-migrate-the-queue", base: "run/return", headSha: "a".repeat(40), baseSha: "b".repeat(40) },
    outcome: { kind: "failed", reason: "push rejected" },
    workspaceCreated: true,
  };
}

test("an Auto Run record round-trips every HITL checkpoint it can hold", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-autorun-record-"));
  const runtime = new RuntimeLayout(root);
  const store = new FileAutoRunStore(runtime);
  assert.equal(await store.load(), undefined);
  const record = fixedPlanRecord();
  await store.save(record);
  assert.deepEqual(await store.load(), record);
  const raw = await readFile(runtime.state("auto-run.json"), "utf8");
  assert.match(raw, /"permanentPrompt": "run browser tests"/);
  assert.match(raw, /"exploreBeforeAddress": true/);
  assert.match(raw, /"additionalGuideline": "keep fixtures small"/);
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test("a landed HITL issue retains temporary checkpoint and final acceptance identities", () => {
  const record = fixedPlanRecord();
  const landed = {
    state: "done",
    result: "landed",
    prNumber: 57,
    issueClosed: true,
    beforeSha: "a".repeat(40),
    addressCommitSha: "b".repeat(40),
    resetCompleted: true,
    hitlReviewCompleted: true,
    implementationSha: "c".repeat(40),
  } as const;
  const parsed = parseAutoRunRecord({ ...record, progress: { ...record.progress, "35": landed }, currentIssue: undefined });
  assert.equal(parsed?.version, 1);
  assert.deepEqual(parsed?.progress["35"], landed);
});

test("auto-run persistence leaves the project clean and recovers from private workspace storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-autorun-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "project");
  const storageRoot = join(root, "vscode-storage");
  const git = promisify(execFile);
  await git("git", ["init", workspaceRoot]);
  const status = async () => (await git("git", ["-C", workspaceRoot, "status", "--porcelain"])).stdout;
  assert.equal(await status(), "");

  const runtime = new RuntimeLayout(storageRoot);
  const store = new FileAutoRunStore(runtime, new RuntimeAdmission(true));
  const record = fixedPlanRecord();
  await store.save(record);
  assert.deepEqual(JSON.parse(await readFile(join(storageRoot, "runtime", "state", "auto-run.json"), "utf8")), record);
  assert.equal(existsSync(join(workspaceRoot, "state")), false);
  assert.equal(existsSync(join(workspaceRoot, ".abd")), false);
  assert.equal(await status(), "");

  const reopened = new FileAutoRunStore(new RuntimeLayout(storageRoot));
  assert.deepEqual(await reopened.load(), record);
  await reopened.clear();
  assert.equal(await store.load(), undefined);
  assert.equal(await status(), "");
});

test("a failed worker session reference survives runtime parsing", () => {
  const workerSession = {
    agentId: "worker-19",
    sessionId: "c15badb6-d6c8-45a6-a59f-e931cd364332",
    type: "address",
    issueNumber: 35,
    continuable: true,
  } as const;
  const parsed = parseAutoRunRecord({ ...fixedPlanRecord(), workerSession });
  assert.equal(parsed?.version, 1);
  assert.deepEqual(parsed?.workerSession, workerSession);
});

test("every pending-action and progress shape survives a round trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-autorun-actions-"));
  const store = new FileAutoRunStore(new RuntimeLayout(root));
  const actions = [
    { kind: "create-branch", branch: "issue/34-x", base: "run/return", baseSha: "c".repeat(40) },
    { kind: "worker-turn", branch: "issue/34-x", parentSha: "d".repeat(40), role: "address", completion: "commit", outcome: "succeeded" },
    { kind: "reset-implementation", branch: "issue/34-x", beforeSha: "d".repeat(40), addressCommitSha: "e".repeat(40) },
    { kind: "close-issue", issue: 34, prNumber: 56, comment: "Accepted" },
    { kind: "cleanup-issue", issue: 34, branch: "issue/34-x", sha: "e".repeat(40) },
    { kind: "push", branch: "issue/34-x", sha: "e".repeat(40) },
    { kind: "create-issue-pr", issue: 34, head: "issue/34-x", base: "run/return" },
    { kind: "merge-issue-pr", prNumber: 56, head: "issue/34-x", base: "run/return", headSha: "a".repeat(40), baseSha: "b".repeat(40) },
    { kind: "create-run-pr", head: "run/return", base: "feature/wip" },
    { kind: "merge-run-pr", prNumber: 60, head: "run/return", base: "feature/wip", headSha: "a".repeat(40), baseSha: "b".repeat(40) },
  ] as const;
  for (const pendingAction of actions) {
    const record = { ...fixedPlanRecord(), pendingAction };
    await store.save(record);
    const loaded = await store.load();
    assert.equal(loaded?.version, 1);
    assert.deepEqual(loaded?.pendingAction, pendingAction, pendingAction.kind);
  }
  for (const outcome of [{ kind: "cancelled" }, { kind: "interrupted" }, { kind: "failed", reason: "boom" }] as const) {
    const record = { ...fixedPlanRecord(), outcome };
    await store.save(record);
    const loaded = await store.load();
    assert.deepEqual(loaded?.outcome, outcome, outcome.kind);
  }
});

// A malformed record is rejected rather than thrown on: that reads as "there is
// no run to recover", which is the safe answer.
test("an unusable auto-run record degrades to nothing to recover", () => {
  const valid = fixedPlanRecord();
  assert.ok(parseAutoRunRecord(valid));
  for (const broken of [
    undefined, null, [], "run",
    { ...valid, version: 5 },
    { ...valid, runId: "" },
    { ...valid, startedAt: "yesterday" },
    { ...valid, checkpoint: "publishing" },
    { ...valid, attempt: 0 },
    { ...valid, settings: { ...valid.settings, mergeStrategy: "fast-forward" } },
    { ...valid, settings: { ...valid.settings, exploreBeforeAddress: "yes" } },
    { ...valid, settings: { ...valid.settings, issueContextDepth: "deep" } },
    { ...valid, workerSession: { agentId: "worker-20", sessionId: "session", type: "explore", issueNumber: 35, continuable: true } },
    { ...valid, settings: undefined },
    { ...valid, plan: [{ number: 34 }] },
    { ...valid, branchShas: { "run/return": "short" } },
    { ...valid, pendingAction: { kind: "push", branch: "run/return", sha: "short" } },
    { ...valid, pendingAction: { kind: "worker-turn", branch: "run/return", parentSha: "a".repeat(40) } },
    { ...valid, pendingAction: { kind: "worker-turn", branch: "run/return", parentSha: "a".repeat(40), role: "explorer", completion: "commit" } },
    { ...valid, pendingAction: { kind: "worker-turn", branch: "run/return", parentSha: "a".repeat(40), role: "address", completion: "commit", outcome: "unknown" } },
    { ...valid, pendingAction: { kind: "reset-implementation", branch: "run/return", beforeSha: "short", addressCommitSha: "b".repeat(40) } },
    { ...valid, progress: { ...valid.progress, "35": { state: "current", phase: "commit", headSha: "short" } } },
    { ...valid, outcome: { kind: "failed" } },
    { ...valid, workerSession: { agentId: "worker-19", sessionId: "session", type: "address", issueNumber: 35, continuable: false } },
  ]) {
    assert.equal(parseAutoRunRecord(broken), undefined, JSON.stringify(broken));
  }
  assert.equal(parseAutoRunRecord({
    ...valid,
    workerSession: { agentId: "worker-20", sessionId: "session", type: "explore", issueNumber: 35 },
  })?.version, 1);
  // An authoritative record is all-or-nothing: silently turning damaged
  // progress into pending work could repeat an issue or a side effect.
  const damaged = parseAutoRunRecord({ ...valid, progress: { ...valid.progress, "35": { state: "halfway" } } });
  assert.equal(damaged, undefined);
});

test("Auto Run rejects records with a different version", () => {
  assert.equal(parseAutoRunRecord({ ...fixedPlanRecord(), version: 2 }), undefined);
});

test("combined bridge handlers stop at the first owned route", async () => {
  const calls: string[] = [];
  const handler = combineHandlers(
    () => { calls.push("first"); return { status: 404 }; },
    () => { calls.push("second"); return { status: 200, body: { ok: true } }; },
    () => { calls.push("third"); return { status: 500 }; },
  );
  const request: AuthenticatedBridgeRequest = { method: "GET", url: new URL("http://127.0.0.1/test"), headers: {}, body: undefined, signal: new AbortController().signal };
  assert.equal((await handler(request)).status, 200);
  assert.deepEqual(calls, ["first", "second"]);
});
