import assert from "node:assert/strict";
import test from "node:test";
import { atomicReplace } from "../../src/runtime/atomic-replace.js";

test("atomic journal replacement retries sharing violations without removing the claim", async () => {
  const calls: string[][] = [];
  const delays: number[] = [];
  await atomicReplace("temporary", "claim", async (from, to) => {
    calls.push([String(from), String(to)]);
    if (calls.length < 3) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
  }, async (ms) => { delays.push(ms); });
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ["temporary", "claim"]));
  assert.deepEqual(delays, [100, 100]);
});

test("replacement fails immediately for unrelated errors and bounds sharing retries", async () => {
  let calls = 0;
  await assert.rejects(atomicReplace("temporary", "claim", async () => {
    calls += 1; throw Object.assign(new Error("missing source"), { code: "ENOENT" });
  }), /missing source/u);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(atomicReplace("temporary", "claim", async () => {
    calls += 1; throw Object.assign(new Error("persistent denial"), { code: "EACCES" });
  }, async () => {}), /persistent denial/u);
  assert.equal(calls, 21);
});
