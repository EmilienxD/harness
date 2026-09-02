import assert from "node:assert/strict";
import test from "node:test";

import { GeneralPurposeQueue } from "../src/bridge/general-purpose-queue.js";
import type { AgentId } from "../src/domain/contracts.js";
import type { GitStatus } from "../src/git/client.js";

test("the queue does not mistake an initially clean tree for completion of the active task", async () => {
  let head = "a".repeat(40);
  let status: GitStatus = { branch: "main", entries: [] };
  let live = true;
  let tick: (() => void) | undefined;
  const launches: string[] = [];
  const queue = new GeneralPurposeQueue({
    git: { status: async () => status, headSha: async () => head, isAncestor: async () => true },
    launcher: { launchQueued: async (input, beforeTerminal) => {
      await beforeTerminal();
      launches.push(input.prompt!);
      return { agentId: `general-${launches.length}` as AgentId };
    } },
    isAgentLive: () => live,
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval: () => {},
  });

  assert.deepEqual(await queue.enqueue("make the first change"), { status: "launched", agentId: "general-1" });
  assert.deepEqual(await queue.enqueue("make the second change"), {
    status: "queued",
    position: 1,
    reason: "the preceding task must finish with a new commit and a clean working tree",
  });

  tick?.();
  await settle();
  assert.equal(launches.length, 1, "a clean tree at the launch commit is not progress");

  live = false;
  tick?.();
  await settle();
  assert.equal(launches.length, 1, "ending the session without a commit does not advance the queue");

  head = "b".repeat(40);
  status = { branch: "main", entries: [{ status: "M", path: "src/index.ts" }] };
  tick?.();
  await settle();
  assert.equal(launches.length, 1, "a new commit does not advance while further work is dirty");

  status = { branch: "main", entries: [] };
  tick?.();
  await settle();
  assert.deepEqual(launches, [
    "make the first change",
    "make the second change",
  ]);
  queue.dispose();
});

test("the first queued task waits only for a completely clean tree", async () => {
  let status: GitStatus = { branch: "main", entries: [{ status: "??", path: "notes.txt" }] };
  let tick: (() => void) | undefined;
  const launches: string[] = [];
  const queue = new GeneralPurposeQueue({
    git: { status: async () => status, headSha: async () => "a".repeat(40), isAncestor: async () => true },
    launcher: { launchQueued: async (input, beforeTerminal) => { await beforeTerminal(); launches.push(input.prompt!); return { agentId: "general-1" as AgentId }; } },
    isAgentLive: () => false,
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval: () => {},
  });

  assert.deepEqual(await queue.enqueue("start when clean"), {
    status: "queued",
    position: 1,
    reason: "the working tree is not clean",
  });
  status = { branch: "main", entries: [] };
  tick?.();
  await settle();
  assert.deepEqual(launches, ["start when clean"]);
  queue.dispose();
});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness() {
  const state = {
    head: "a".repeat(40),
    clean: true,
    live: false,
    descendant: true,
    allowed: true,
    prepare: async (): Promise<void> => {},
    readStatus: async (): Promise<void> => {},
  };
  let tick = () => {};
  let polls = 0;
  const launches: string[] = [];
  const queue = new GeneralPurposeQueue({
    git: {
      headSha: async () => state.head,
      status: async () => {
        polls += 1;
        await state.readStatus();
        return { branch: "main", entries: state.clean ? [] : [{ status: "M", path: "file.ts" }] };
      },
      isAncestor: async () => state.descendant,
    },
    launcher: { launchQueued: async (input, beforeTerminal) => {
      await state.prepare();
      await beforeTerminal();
      launches.push(input.prompt!);
      return { agentId: `agent-${launches.length}` as AgentId };
    } },
    canLaunch: () => state.allowed,
    isAgentLive: () => state.live,
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval: () => { tick = () => {}; },
  });
  return { state, queue, launches, tick: async () => { tick(); await settle(); }, polls: () => polls };
}

test("simultaneous submissions launch FIFO, one new commit boundary per task", async (context) => {
  const h = harness(); context.after(() => h.queue.dispose());
  const results = await Promise.all(["one", "two", "three"].map((prompt) => h.queue.enqueue(prompt)));
  assert.equal(results[0]?.status, "launched");
  assert.equal(results[1]?.status === "queued" && results[1].position, 1);
  assert.equal(results[2]?.status === "queued" && results[2].position, 2);
  assert.deepEqual(h.launches, ["one"]);
  h.state.head = "b".repeat(40);
  h.state.live = true;
  await h.tick();
  assert.deepEqual(h.launches, ["one"], "a mid-task commit cannot start a competing agent");
  h.state.live = false;
  await h.tick();
  await h.tick();
  assert.deepEqual(h.launches, ["one", "two"]);
  h.state.head = "c".repeat(40);
  await h.tick();
  assert.deepEqual(h.launches, ["one", "two", "three"]);
});

test("an unrelated HEAD or reset is not a new commit after the preceding task", async (context) => {
  const h = harness(); context.after(() => h.queue.dispose());
  await h.queue.enqueue("one");
  await h.queue.enqueue("two");
  h.state.head = "b".repeat(40);
  h.state.descendant = false;
  await h.tick();
  assert.deepEqual(h.launches, ["one"]);
  h.state.descendant = true;
  await h.tick();
  assert.deepEqual(h.launches, ["one", "two"]);
});

test("a dirty tree during preparation refuses the terminal and retains the task", async (context) => {
  const h = harness(); context.after(() => h.queue.dispose());
  h.state.prepare = async () => { h.state.clean = false; };
  assert.equal((await h.queue.enqueue("one")).status, "queued");
  assert.deepEqual(h.launches, []);
  h.state.prepare = async () => {};
  h.state.clean = true;
  await h.tick();
  assert.deepEqual(h.launches, ["one"]);
});

test("the baseline is the HEAD at terminal creation, not before launch preparation", async (context) => {
  const h = harness(); context.after(() => h.queue.dispose());
  h.state.prepare = async () => { h.state.head = "b".repeat(40); };
  await h.queue.enqueue("one");
  await h.queue.enqueue("two");
  await h.tick();
  assert.deepEqual(h.launches, ["one"]);
});

test("clearing during a Git read or launch preparation cancels old work without launching it", async (context) => {
  for (const boundary of ["readStatus", "prepare"] as const) {
    const h = harness(); context.after(() => h.queue.dispose());
    let resume = () => {};
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    h.state[boundary] = () => gate;
    const pending = h.queue.enqueue("old work");
    await settle();
    h.queue.clear();
    h.state[boundary] = async () => {};
    const fresh = h.queue.enqueue("new work");
    resume();
    assert.deepEqual(await pending, { status: "cancelled" });
    assert.equal((await fresh).status, "launched");
    assert.deepEqual(h.launches, ["new work"]);
  }
});

test("slow checks coalesce timer ticks and disposal cancels pending work", async () => {
  const h = harness();
  h.state.allowed = false;
  await h.queue.enqueue("one");
  h.state.allowed = true;
  let resume = () => {};
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  h.state.readStatus = () => gate;
  await h.tick();
  await h.tick();
  await h.tick();
  assert.equal(h.polls(), 1);
  h.queue.dispose();
  resume();
  await settle();
  await h.tick();
  assert.equal(h.polls(), 1);
  assert.deepEqual(h.launches, []);
  assert.deepEqual(await h.queue.enqueue("after disposal"), { status: "cancelled" });
});
