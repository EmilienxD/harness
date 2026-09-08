import assert from "node:assert/strict";
import test from "node:test";

import type { AgentId, IsoTimestamp, SessionId } from "../src/domain/contracts.js";
import { dirtyTreeFailure, isStaleLease, leaseRequired, WriteLease } from "../src/domain/lease.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
test("only Auto Run launches are leased", () => {
  const interactive = true;
  assert.equal(leaseRequired("auto-run", !interactive), true);
  assert.equal(leaseRequired("auto-run", interactive), true);
  assert.equal(leaseRequired("user", !interactive), false);
  assert.equal(leaseRequired("user", interactive), false);
});

test("acquires, refuses with holder age, releases, and permits concurrent readers", () => {
  const lease = new WriteLease();
  const first = lease.acquire("write-capable", { agentId: agent("writer-1"), sessionId: session("session-1") }, at("2026-07-30T10:00:00.000Z"), "worker launch");
  assert.equal(first.acquired, true);
  const reader = lease.acquire("read-only", { agentId: agent("reader"), sessionId: session("session-r") }, at("2026-07-30T10:01:00.000Z"), "review launch");
  assert.deepEqual(reader, { acquired: true, required: false });
  const refused = lease.acquire("write-capable", { agentId: agent("writer-2"), sessionId: session("session-2") }, at("2026-07-30T10:02:00.000Z"), "worker launch");
  assert.equal(refused.acquired, false);
  if (!refused.acquired) {
    assert.equal(refused.holder.agentId, "writer-1");
    assert.equal(refused.ageMs, 120_000);
  }
  assert.equal(lease.release(agent("writer-2"), at("2026-07-30T10:03:00.000Z"), "wrong holder"), false);
  assert.equal(lease.release(agent("writer-1"), at("2026-07-30T10:03:00.000Z"), "terminal completed"), true);
  assert.equal(lease.current(), undefined);
});

test("force release is conspicuous and auditable", () => {
  const lease = new WriteLease();
  lease.acquire("write-capable", { agentId: agent("writer"), sessionId: session("session") }, at("2026-07-30T10:00:00.000Z"), "worker launch");
  assert.equal(lease.forceRelease(at("2026-07-30T10:05:00.000Z"), "user confirmed stuck terminal"), true);
  assert.equal(lease.events().at(-1)?.type, "force-released");
  assert.equal(lease.events().at(-1)?.reason, "user confirmed stuck terminal");
});

test("rejects empty audit reasons without mutating lease state", () => {
  const lease = new WriteLease();
  assert.throws(() => lease.acquire("write-capable", { agentId: agent("writer"), sessionId: session("session") }, at("2026-07-30T10:00:00.000Z"), " "));
  assert.equal(lease.current(), undefined);
  lease.acquire("write-capable", { agentId: agent("writer"), sessionId: session("session") }, at("2026-07-30T10:00:00.000Z"), "worker launch");
  assert.throws(() => lease.forceRelease(at("2026-07-30T10:01:00.000Z"), ""));
  assert.equal(lease.current()?.agentId, "writer");
});

test("stale recovery requires both terminal and session evidence to be non-live", () => {
  assert.equal(isStaleLease({ terminal: "closed", session: "ended" }), true);
  assert.equal(isStaleLease({ terminal: "missing", session: "missing" }), true);
  assert.equal(isStaleLease({ terminal: "open", session: "ended" }), false);
  assert.equal(isStaleLease({ terminal: "closed", session: "live" }), false);

  const lease = new WriteLease();
  lease.acquire("write-capable", { agentId: agent("writer"), sessionId: session("session") }, at("2026-07-30T10:00:00.000Z"), "restored lease");
  assert.equal(lease.recoverStale({ terminal: "closed", session: "live" }, at("2026-07-30T10:01:00.000Z"), "reconciliation"), false);
  assert.equal(lease.recoverStale({ terminal: "closed", session: "ended" }, at("2026-07-30T10:02:00.000Z"), "terminal closed and session ended"), true);
  assert.equal(lease.events().at(-1)?.type, "stale-released");
});

test("dirty-tree failure stays typed while every terminal outcome releases", () => {
  const lease = new WriteLease();
  lease.acquire("write-capable", { agentId: agent("writer"), sessionId: session("session") }, at("2026-07-30T10:00:00.000Z"), "worker launch");
  const failure = dirtyTreeFailure(0, "finished without committing");
  assert.equal(failure.type, "no-commit");
  assert.equal(lease.releaseForTerminalOutcome(agent("writer"), at("2026-07-30T10:10:00.000Z"), `terminal outcome: ${failure.type}`), true);
  assert.equal(lease.current(), undefined);
});
