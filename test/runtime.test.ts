import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetRegistry } from "../src/domain/fleet.js";
import { ActivityRecorder } from "../src/runtime/activity-recorder.js";
import type { ActivityDto } from "../src/domain/activity.js";
import { FileActivityStore, FileAutoRunStore, PersistOnChange, parseAutoRunRecord, FileFleetStore } from "../src/runtime/persistence.js";
import type { AutoRunRecord } from "../src/domain/run-plan.js";
import { combineHandlers } from "../src/bridge/router.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import { RuntimeAdmission, RuntimeStartup } from "../src/runtime/admission.js";

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
  const root = await mkdtemp(join(tmpdir(), "aboard-runtime-"));
  const store = new FileFleetStore(root);
  const fleet = new FleetRegistry();
  await store.save(fleet.toPersistenceDto());
  assert.deepEqual(await store.load(), fleet.toPersistenceDto());
  const path = join(root, ".aboard", "runtime", "fleet.json");
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

test("removing the project state drops the activity cache instead of resurrecting it", async () => {
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

  // The user deletes `.aboard/`: admission closes, then the directory goes.
  initialized = false;
  await admission.close();
  await rm(join(root, ".aboard"), { recursive: true, force: true });
  const before = changes;
  await recorder.reset();
  assert.deepEqual(recorder.entries(), []);
  assert.equal(changes, before + 1);
  assert.equal(existsSync(join(root, ".aboard")), false);

  // Initializing again starts from the store on disk, not from this process.
  initialized = true;
  admission.open();
  await recorder.load();
  assert.deepEqual(recorder.entries(), []);
  recorder.recordRun({ runId: "run_after", attempt: 1, outcome: "started" });
  await recorder.settle();
  const persisted = JSON.parse(await readFile(join(root, ".aboard", "runtime", "activity.json"), "utf8")) as ActivityDto;
  assert.deepEqual(persisted.entries.map((entry) => entry.kind === "run" ? entry.runId : entry.kind), ["run_after"]);
});

/** A complete version-2 record, so each test states only what it is about. */
function fixedPlanRecord(): AutoRunRecord {
  return {
    version: 2,
    runId: "run_return",
    startedAt: "2026-07-31T09:12:04.221Z",
    updatedAt: "2026-07-31T10:00:00.000Z",
    attempt: 2,
    settings: {
      review: true,
      recursiveIssueReferences: true,
      mergeStrategy: "merge",
      mergeRunPullRequest: true,
      pauseAfterHitl: false,
      pollSeconds: 45,
      worktree: { enabled: true, root: "C:/checkouts", keep: false, setupTimeoutSeconds: 900 },
      workspaceRoot: "C:/checkouts/run_return/aboard",
      additionalGuideline: "keep fixtures small",
    },
    plan: [
      { number: 34, title: "Add retry backoff", branch: "aboard/34-add-retry-backoff", disposition: "afk", difficulty: "advanced", chrome: true, dependsOn: [] },
      { number: 35, title: "Migrate the queue", branch: "aboard/35-migrate-the-queue", disposition: "hitl", dependsOn: [34] },
    ],
    progress: {
      "34": { state: "done", result: "landed", prNumber: 56, issueClosed: true },
      "35": { state: "current", phase: "await-approval", prNumber: 57, headSha: "b".repeat(40), reviewed: true },
    },
    sessionBranch: "aboard/run/return",
    targetBranch: "feature/wip",
    branchShas: { "aboard/run/return": "a".repeat(40), "aboard/35-migrate-the-queue": "b".repeat(40) },
    currentIssue: 35,
    checkpoint: "issue",
    runPullRequest: 60,
    reviewedIssues: [35],
    pendingAction: { kind: "merge-issue-pr", prNumber: 57, head: "aboard/35-migrate-the-queue", base: "aboard/run/return", headSha: "a".repeat(40), baseSha: "b".repeat(40) },
    outcome: { kind: "failed", reason: "push rejected" },
    workspaceCreated: true,
  };
}

test("a version-2 record round-trips every discriminated state it can hold", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-autorun-record-"));
  const store = new FileAutoRunStore(root);
  assert.equal(await store.load(), undefined);
  const record = fixedPlanRecord();
  await store.save(record);
  assert.deepEqual(await store.load(), record);
  const raw = await readFile(join(root, ".aboard", "runtime", "auto-run.json"), "utf8");
  assert.match(raw, /"additionalGuideline": "keep fixtures small"/);
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test("every pending-action and progress shape survives a round trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-autorun-actions-"));
  const store = new FileAutoRunStore(root);
  const actions = [
    { kind: "create-branch", branch: "aboard/34-x", base: "aboard/run/return", baseSha: "c".repeat(40) },
    { kind: "commit", branch: "aboard/34-x", parentSha: "d".repeat(40), message: "Add retry backoff", treeSha: "e".repeat(40), fingerprint: ["src/a.ts", "src/b.ts"] },
    { kind: "push", branch: "aboard/34-x", sha: "e".repeat(40) },
    { kind: "create-issue-pr", issue: 34, head: "aboard/34-x", base: "aboard/run/return" },
    { kind: "merge-issue-pr", prNumber: 56, head: "aboard/34-x", base: "aboard/run/return", headSha: "a".repeat(40), baseSha: "b".repeat(40) },
    { kind: "create-run-pr", head: "aboard/run/return", base: "feature/wip" },
    { kind: "merge-run-pr", prNumber: 60, head: "aboard/run/return", base: "feature/wip", headSha: "a".repeat(40), baseSha: "b".repeat(40) },
  ] as const;
  for (const pendingAction of actions) {
    const record = { ...fixedPlanRecord(), pendingAction };
    await store.save(record);
    const loaded = await store.load();
    assert.equal(loaded?.version, 2);
    assert.deepEqual(loaded?.version === 2 ? loaded.pendingAction : undefined, pendingAction, pendingAction.kind);
  }
  for (const outcome of [{ kind: "cancelled" }, { kind: "interrupted" }, { kind: "failed", reason: "boom" }] as const) {
    const record = { ...fixedPlanRecord(), outcome };
    await store.save(record);
    const loaded = await store.load();
    assert.deepEqual(loaded?.version === 2 ? loaded.outcome : undefined, outcome, outcome.kind);
  }
});

// A malformed record is rejected rather than thrown on: that reads as "there is
// no run to recover", which is the safe answer.
test("an unusable auto-run record degrades to nothing to recover", () => {
  const valid = fixedPlanRecord();
  assert.ok(parseAutoRunRecord(valid));
  for (const broken of [
    undefined, null, [], "run",
    { ...valid, version: 3 },
    { ...valid, runId: "" },
    { ...valid, startedAt: "yesterday" },
    { ...valid, checkpoint: "publishing" },
    { ...valid, attempt: 0 },
    { ...valid, settings: { ...valid.settings, mergeStrategy: "fast-forward" } },
    { ...valid, settings: { ...valid.settings, recursiveIssueReferences: "yes" } },
    { ...valid, settings: undefined },
    { ...valid, plan: [{ number: 34 }] },
    { ...valid, branchShas: { "aboard/run/return": "short" } },
    { ...valid, pendingAction: { kind: "push", branch: "aboard/run/return", sha: "short" } },
    { ...valid, progress: { ...valid.progress, "35": { state: "current", phase: "commit", headSha: "short" } } },
    { ...valid, outcome: { kind: "failed" } },
  ]) {
    assert.equal(parseAutoRunRecord(broken), undefined, JSON.stringify(broken));
  }
  const priorRecord = parseAutoRunRecord({
    ...valid,
    settings: Object.fromEntries(Object.entries(valid.settings).filter(([key]) => key !== "recursiveIssueReferences")),
  });
  assert.equal(priorRecord?.version === 2 ? priorRecord.settings.recursiveIssueReferences : undefined, false);
  // An authoritative record is all-or-nothing: silently turning damaged
  // progress into pending work could repeat an issue or a side effect.
  const damaged = parseAutoRunRecord({ ...valid, progress: { ...valid.progress, "35": { state: "halfway" } } });
  assert.equal(damaged, undefined);
});

test("a version-1 record surfaces as unsupported rather than disappearing or migrating", () => {
  const legacy = parseAutoRunRecord({
    version: 1,
    runId: "run_old",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "commit",
    reviewMode: true,
    startedAt: "2026-07-31T09:12:04.221Z",
  });
  assert.deepEqual(legacy, { version: 1, runId: "run_old", startedAt: "2026-07-31T09:12:04.221Z" });
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
