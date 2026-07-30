import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetRegistry } from "../src/domain/fleet.js";
import { FileFleetStore, PersistOnChange } from "../src/runtime/persistence.js";
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

test("persistence drains queued writes and performs a final save on disposal", async () => {
  let listener: (() => void) | undefined;
  let saves = 0;
  const persistence = new PersistOnChange((registered) => { listener = registered; return { dispose() { listener = undefined; } }; }, async () => { saves += 1; }, () => assert.fail("save failed"));
  listener?.(); listener?.();
  await persistence.dispose();
  assert.equal(saves, 3);
  assert.equal(listener, undefined);
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
