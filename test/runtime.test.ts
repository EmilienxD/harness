import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetRegistry } from "../src/domain/fleet.js";
import { FileAutoRunStore, PersistOnChange, parseAutoRunRecord, FileFleetStore, FileTodoNumberStore } from "../src/runtime/persistence.js";
import type { AutoRunRecord } from "../src/domain/auto-run.js";
import { combineHandlers } from "../src/bridge/router.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";

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

test("the TODO number round-trips and degrades junk to no record", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-todo-"));
  const store = new FileTodoNumberStore(root);
  assert.equal(await store.load(), undefined);
  await store.save(44);
  assert.equal(await store.load(), 44);
  const path = join(root, ".aboard", "runtime", "todo.json");
  await writeFile(path, '"Project TODO"', "utf8");
  assert.equal(await store.load(), undefined);
  await store.remove();
  assert.equal(await store.load(), undefined);
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

test("the auto-run record round-trips, carries no prompt text, and clears on discard", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-autorun-"));
  const store = new FileAutoRunStore(root);
  assert.equal(await store.load(), undefined);
  const record: AutoRunRecord = {
    version: 1,
    runId: "run_01H",
    specNumber: 12,
    issueNumbers: [34, 35],
    currentIssue: 35,
    phase: "await-approval",
    branch: "aboard/35-migrate-the-queue",
    prNumber: 57,
    reviewMode: false,
    scope: "spec",
    reviewedIssues: [],
    startedAt: "2026-07-31T09:12:04.221Z",
  };
  await store.save(record);
  assert.deepEqual(await store.load(), record);
  const raw = await readFile(join(root, ".aboard", "runtime", "auto-run.json"), "utf8");
  assert.doesNotMatch(raw, /prompt/i);
  await store.clear();
  assert.equal(await store.load(), undefined);
});

// The record is only a resume hint, so anything unusable degrades to "no run to
// resume" rather than an error: the engine re-derives every fact anyway.
test("an unusable auto-run record degrades to nothing to resume", () => {
  const valid = { version: 1, runId: "r", specNumber: 12, issueNumbers: [34], currentIssue: 34, phase: "commit", branch: "b", prNumber: 1, reviewMode: true, scope: "all", startedAt: "2026-07-31T09:12:04.221Z" };
  assert.ok(parseAutoRunRecord(valid));
  for (const broken of [
    undefined, null, [], "run",
    { ...valid, version: 2 },
    { ...valid, phase: "publish" },
    { ...valid, scope: "everything" },
    { ...valid, specNumber: 0 },
    { ...valid, reviewMode: "yes" },
    { ...valid, issueNumbers: [34, "x"] },
    { ...valid, startedAt: "yesterday" },
  ]) {
    assert.equal(parseAutoRunRecord(broken), undefined, JSON.stringify(broken));
  }
  // Optional fields legitimately absent, not malformed.
  assert.equal(parseAutoRunRecord({ ...valid, currentIssue: undefined, branch: undefined, prNumber: undefined })?.currentIssue, undefined);
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
