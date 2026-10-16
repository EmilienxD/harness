import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceBatchLauncher, presentWorkspaceBatchResult } from "../../src/platform/workspace-launcher.js";

test("new workspace terminals open in their assigned panes before earlier agents finish starting", async () => {
  const ready = Array.from({ length: 2 }, () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  });
  const panes = [{}, {}];
  const opened: unknown[] = [];
  const focused: string[] = [];
  const launcher = new WorkspaceBatchLauncher({
    providers: ["chatgpt"], initialized: () => false,
    markInitialized: async () => {}, initializeLayout: async () => panes,
    launch: async (_provider, pane, onCreated?: () => void) => {
      const index = opened.length;
      opened.push(pane);
      onCreated?.();
      await ready[index]!.promise;
      return { terminalId: `terminal-${index}` };
    },
    focus: (id) => { focused.push(id); },
  });
  const pending = launcher.launch({ preset: { id: "pair", name: "Pair", columns: 1, rows: 2, panes: [{ providers: ["chatgpt"] }, { providers: ["chatgpt"] }] }, empty: false, manual: true });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, panes, "a slow first agent must not delay opening the second terminal");
    assert.deepEqual(focused, [], "startup must still be confirmed before the batch finishes");
  } finally {
    for (const gate of ready) gate.resolve();
    const result = await pending;
    assert.equal(result.started, 2);
    assert.deepEqual(focused, ["terminal-0"]);
  }
});

test("workspace batches retain successful sessions, initialize only once, and focus once", async () => {
  let initialized = false;
  const layouts: number[] = [];
  const launches: string[] = [];
  const focused: string[] = [];
  const launcher = new WorkspaceBatchLauncher({
    providers: ["claude", "chatgpt"],
    initialized: () => initialized,
    markInitialized: async () => { initialized = true; },
    initializeLayout: async (columns, rows) => { layouts.push(columns * rows); return [{}, {}]; },
    launch: async (provider) => { launches.push(provider); if (provider === "claude") throw new Error("missing CLI"); return { terminalId: "live" }; },
    focus: (id) => { focused.push(id); },
  });
  const plan = { preset: { id: "test", name: "Test", columns: 1, rows: 2, panes: [{ providers: ["chatgpt"] }, { providers: ["claude"] }] }, empty: false, manual: true };
  const result = await launcher.launch(plan);
  assert.equal(result.started, 1);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(focused, ["live"]);
  await assert.rejects(launcher.launch({ ...plan, empty: true }), /already initialized/);
  assert.deepEqual(layouts, [2]);
  assert.deepEqual(launches, ["chatgpt", "claude"]);
});

test("Current window applies the preset grid and assigns terminals to its panes on each explicit launch", async () => {
  const panes = [{}, {}];
  const layouts: number[][] = [];
  const launched: { provider: string; pane: object | undefined }[] = [];
  const launcher = new WorkspaceBatchLauncher({
    providers: ["claude", "chatgpt"], initialized: () => true,
    markInitialized: async () => assert.fail("an explicit launch does not replay workspace initialization"),
    initializeLayout: async (columns, rows) => { layouts.push([columns, rows]); return panes; },
    launch: async (provider, pane, onCreated) => { launched.push({ provider, pane }); onCreated(); return { terminalId: String(launched.length) }; },
    focus: () => {},
  });
  const plan = { preset: { id: "pair", name: "Pair", columns: 2, rows: 1, panes: [{ providers: ["chatgpt"] }, { providers: ["claude"] }] }, empty: false, manual: true };
  assert.deepEqual(await launcher.launchCurrent(plan), { started: 2, failed: [], cancelled: 0 });
  assert.deepEqual(layouts, [[2, 1]]);
  assert.deepEqual(launched, [{ provider: "chatgpt", pane: panes[0] }, { provider: "claude", pane: panes[1] }]);
  assert.equal((await launcher.launchCurrent({ ...plan, preset: { ...plan.preset, columns: 1, rows: 2 } })).started, 2);
  assert.deepEqual(layouts, [[2, 1], [1, 2]], "a later explicit launch applies its selected grid");
  assert.equal(launched.length, 4);
  assert.throws(() => launcher.launchCurrent({ ...plan, preset: { ...plan.preset, panes: [{ providers: ["pi"] }, { providers: [] }] } }), /unavailable provider/);
});

test("batch progress distinguishes agents still starting from ready and failed agents", async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  const progress: unknown[] = [];
  const launcher = new WorkspaceBatchLauncher({
    providers: ["claude", "chatgpt"], initialized: () => false,
    markInitialized: async () => {}, initializeLayout: async () => [],
    launch: async (provider) => {
      await ready;
      if (provider === "claude") throw new Error("missing CLI");
      return { terminalId: "live" };
    },
    focus: () => {},
  });
  const pending = launcher.launch({ preset: { id: "progress", name: "Progress", columns: 1, rows: 1, panes: [{ providers: ["chatgpt", "claude"] }] }, empty: false }, (value: unknown) => { progress.push(value); });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(progress, [{ total: 2, started: 0, failed: 0 }]);
  } finally {
    finish();
    await pending;
  }
  assert.deepEqual(progress, [
    { total: 2, started: 0, failed: 0 },
    { total: 2, started: 1, failed: 0 },
    { total: 2, started: 1, failed: 1 },
  ]);
});

test("empty initialization and retry after initialization failure create no duplicate geometry or sessions", async () => {
  let initialized = false;
  let layouts = 0;
  const launcher = new WorkspaceBatchLauncher({
    providers: ["chatgpt"], initialized: () => initialized,
    markInitialized: async () => { initialized = true; },
    initializeLayout: async () => { if (++layouts === 1) throw new Error("editor unavailable"); return []; },
    launch: async () => { throw new Error("empty request must never start an agent"); },
    focus: () => assert.fail("empty request must never focus a terminal"),
  });
  const plan = { preset: { id: "empty", name: "Empty", columns: 1, rows: 2, panes: [{ providers: [] }, { providers: [] }] }, empty: true };
  assert.equal((await launcher.launch(plan)).failed.length, 1);
  const retried = await launcher.launch({ ...plan });
  assert.equal(retried.failed.length, 0);
  assert.equal(retried.started, 0);
  assert.equal(layouts, 2);
});

test("unknown providers are rejected before any layout or terminal side effects", async () => {
  const launcher = new WorkspaceBatchLauncher({
    providers: ["claude", "chatgpt"], initialized: () => false,
    markInitialized: async () => assert.fail("must not initialize"),
    initializeLayout: async () => assert.fail("must not rearrange"),
    launch: async () => assert.fail("must not launch"), focus: () => assert.fail("must not focus"),
  });
  assert.throws(() => launcher.launch({ preset: { id: "invalid", name: "Invalid", columns: 1, rows: 1, panes: [{ providers: ["pi"] }] }, empty: false }), /unavailable provider/);
});

for (const current of [false, true]) test(`Empty assignments launch shell tabs alongside agents in the ${current ? "current" : "new"} window`, async () => {
  const panes = [{}, {}];
  const opened: { provider: string; pane: object | undefined }[] = [];
  const launcher = new WorkspaceBatchLauncher({
    providers: ["chatgpt"], initialized: () => current,
    markInitialized: async () => {}, initializeLayout: async () => panes,
    launch: async (provider, pane, onCreated) => {
      opened.push({ provider, pane }); onCreated(); return { terminalId: String(opened.length) };
    },
    focus: () => {},
  });
  const plan = { preset: { id: "shells", name: "Shells", columns: 2, rows: 1, panes: [{ providers: ["", "chatgpt", ""] }, { providers: [] }] }, empty: false };
  const result = await (current ? launcher.launchCurrent(plan) : launcher.launch(plan));
  assert.deepEqual(result, { started: 4, failed: [], cancelled: 0 });
  assert.deepEqual(opened, [
    { provider: "", pane: panes[0] }, { provider: "chatgpt", pane: panes[0] }, { provider: "", pane: panes[0] },
    { provider: "", pane: panes[1] },
  ]);
});

test("cancelling before the first agent stops the batch without starting later assignments", async () => {
  let attempts = 0;
  const launcher = new WorkspaceBatchLauncher({
    providers: ["claude", "chatgpt"], initialized: () => false,
    markInitialized: async () => {}, initializeLayout: async () => [],
    launch: async () => { attempts++; throw Object.assign(new Error("User cancelled"), { name: "SessionStartCancelledError" }); },
    focus: () => assert.fail("cancelled launch must not focus"),
  });
  const result = await launcher.launch({ preset: { id: "cancel", name: "Cancel", columns: 1, rows: 1, panes: [{ providers: ["chatgpt", "claude"] }] }, empty: false });
  assert.equal(attempts, 1);
  assert.equal(result.started, 0);
  assert.deepEqual(result.failed, []);
  assert.equal(result.cancelled, 2);
});

test("batch failures are reported once without offering to recreate agents", async () => {
  const notifications: string[][] = [];
  const notify = async (_message: string, ...actions: string[]) => { notifications.push(actions); return "Retry"; };
  await presentWorkspaceBatchResult({ started: 2, cancelled: 0, failed: [{ provider: "claude", message: "failed" }] }, notify);
  assert.deepEqual(notifications, [[]]);
  notifications.length = 0;
  await presentWorkspaceBatchResult({ started: 0, cancelled: 0, failed: [{ provider: "claude", message: "failed" }] }, notify);
  assert.deepEqual(notifications, [[]]);
  notifications.length = 0;
  await presentWorkspaceBatchResult({ started: 0, cancelled: 0, failed: [] }, notify);
  await presentWorkspaceBatchResult({ started: 0, cancelled: 2, failed: [] }, notify);
  assert.equal(notifications.length, 0);
  await presentWorkspaceBatchResult({ started: 0, cancelled: 0, failed: [{ provider: "claude", message: "uncertain", retrySafe: false }] }, notify);
  assert.deepEqual(notifications, [[]]);
});

for (const manual of [false, true]) test(`${manual ? "manual" : "automatic"} workspace batches cannot recreate agents in an initialized window`, async () => {
  const launcher = new WorkspaceBatchLauncher({
    providers: ["chatgpt"], initialized: () => true,
    markInitialized: async () => assert.fail("already initialized"),
    initializeLayout: async () => assert.fail("must retain user's geometry"),
    launch: async () => assert.fail("must not add agents to an initialized workspace"),
    focus: () => assert.fail("must preserve focus"),
  });
  await assert.rejects(launcher.launch({ preset: { id: "changed", name: "Changed", columns: 2, rows: 1, panes: [{ providers: ["chatgpt"] }, { providers: [] }] }, empty: false, manual }), /already initialized/);
});
