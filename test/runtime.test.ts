import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetRegistry } from "../src/domain/fleet.js";
import { FileAutoRunStore, PersistOnChange, parseAutoRunRecord, FileFleetStore } from "../src/runtime/persistence.js";
import type { AutoRunRecord } from "../src/domain/auto-run.js";
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

test("the auto-run record round-trips its session guideline and clears on discard", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-autorun-"));
  const store = new FileAutoRunStore(root);
  assert.equal(await store.load(), undefined);
  const record: AutoRunRecord = {
    version: 1,
    runId: "run_01H",
    issueNumbers: [34, 35],
    currentIssue: 35,
    phase: "await-approval",
    branch: "aboard/35-migrate-the-queue",
    prNumber: 57,
    reviewMode: false,
    chromeEnabled: true,
    additionalGuideline: "no unit tests needed",
    reviewedIssues: [],
    startedAt: "2026-07-31T09:12:04.221Z",
  };
  await store.save(record);
  // The record carries the branch the user was on when the run started, so a
  // resumed run still knows where to return after a restart.
  assert.deepEqual(await store.load(), { ...record, returnBranch: undefined });
  const raw = await readFile(join(root, ".aboard", "runtime", "auto-run.json"), "utf8");
  assert.match(raw, /"additionalGuideline": "no unit tests needed"/);
  assert.match(raw, /"chromeEnabled": true/);
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test("an auto-run record preserves the branch to return to at end-of-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-autorun-return-"));
  const store = new FileAutoRunStore(root);
  const record: AutoRunRecord = {
    version: 1,
    runId: "run_return",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "cleanup",
    branch: "aboard/34-add-retry-backoff",
    prNumber: 56,
    reviewMode: false,
    returnBranch: "feature/wip",
    reviewedIssues: [],
    startedAt: "2026-07-31T09:12:04.221Z",
  };
  await store.save(record);
  assert.equal((await store.load())?.returnBranch, "feature/wip");
});

// The record is only a resume hint, so anything unusable degrades to "no run to
// resume" rather than an error: the engine re-derives every fact anyway.
test("an unusable auto-run record degrades to nothing to resume", () => {
  const valid = { version: 1, runId: "r", issueNumbers: [34], currentIssue: 34, phase: "commit", branch: "b", prNumber: 1, reviewMode: true, startedAt: "2026-07-31T09:12:04.221Z" };
  assert.ok(parseAutoRunRecord(valid));
  assert.equal(parseAutoRunRecord(valid)?.chromeEnabled, false);
  assert.equal(parseAutoRunRecord({ ...valid, additionalGuideline: "  keep fixtures small  " })?.additionalGuideline, "keep fixtures small");
  assert.equal(parseAutoRunRecord({ ...valid, additionalGuideline: 42 })?.additionalGuideline, undefined);
  for (const broken of [
    undefined, null, [], "run",
    { ...valid, version: 2 },
    { ...valid, phase: "publish" },
    { ...valid, reviewMode: "yes" },
    { ...valid, issueNumbers: [34, "x"] },
    { ...valid, startedAt: "yesterday" },
  ]) {
    assert.equal(parseAutoRunRecord(broken), undefined, JSON.stringify(broken));
  }
  // A record an older version wrote still names a spec and a scope. Back-compat
  // is by removal: the fields are ignored, and the run resumes off the
  // repository exactly as a current record does.
  const legacy = parseAutoRunRecord({ ...valid, specNumber: 12, scope: "all" });
  assert.deepEqual(legacy, parseAutoRunRecord(valid));
  // Optional fields legitimately absent, not malformed.
  assert.equal(parseAutoRunRecord({ ...valid, currentIssue: undefined, branch: undefined, prNumber: undefined })?.currentIssue, undefined);
  // A malformed returnBranch degrades to undefined rather than rejecting the record:
  // a run that started on a detached HEAD recorded none, and so did older records.
  assert.equal(parseAutoRunRecord({ ...valid, returnBranch: 42 })?.returnBranch, undefined);
  assert.equal(parseAutoRunRecord({ ...valid, returnBranch: "feature/wip" })?.returnBranch, "feature/wip");
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
