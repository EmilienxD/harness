import assert from "node:assert/strict";
import test from "node:test";
import { registerReopenCommand } from "../../src/vscode/reopen.js";
import { ReopenCoordinator } from "../../src/platform/reopen.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import type { NativeSession } from "../../src/platform/native-sessions.js";
import type { SessionId } from "../../src/domain/contracts.js";

function coordinator(discover: (publish?: (sessions: readonly NativeSession[]) => void) => Promise<readonly NativeSession[]>) {
  return new ReopenCoordinator({
    activity: { entries: () => ({ version: 1, entries: [] }) }, fleet: new FleetRegistry(), discover,
    terminals: { isOpen: () => false, liveTerminalFor: () => undefined, show() {} },
    isResumable: async () => true,
    launcher: { reopen: async () => { throw new Error("must not launch"); } },
  });
}
test("Reopen refreshes during discovery without debounce starvation and stops after dismissal", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  const sizes: number[] = [];
  let command: (() => unknown) | undefined;
  registerReopenCommand({
    registerCommand: (_name, callback) => { command = callback; return { dispose() {} }; },
    pick: async (_items, _placeholder, load) => {
      await load?.((items) => sizes.push(items.length), abort.signal);
      return undefined;
    }, info() {}, warning() {}, error(message) { assert.fail(message); },
  }, coordinator(async (publish) => {
    publish?.([session(0)]);
    publish?.([session(0), session(1)]);
    context.mock.timers.tick(100);
    publish?.([session(0), session(1), session(2)]);
    context.mock.timers.tick(49);
    assert.deepEqual(sizes, [1]);
    context.mock.timers.tick(1);
    assert.deepEqual(sizes, [1, 3]);
    publish?.([session(0), session(1), session(2), session(3)]);
    abort.abort();
    context.mock.timers.tick(1000);
    assert.deepEqual(sizes, [1, 3]);
    return [session(0)];
  }));
  await command?.();
  assert.deepEqual(sizes, [1, 3]);
});

const session = (index: number): NativeSession => ({ platform: "pi", sessionId: `session-${index}` as SessionId, cwd: "/project", at: "2026-01-01T00:00:00.000Z" });

test("Reopen command coalesces a large discovery burst before rendering and retains every final row", async () => {
  let command: (() => unknown) | undefined;
  const sizes: number[] = [];
  registerReopenCommand({
    registerCommand: (_name, callback) => { command = callback; return { dispose() {} }; },
    pick: async (_items, _placeholder, load) => {
      await load?.((items) => sizes.push(items.length), new AbortController().signal);
      return undefined;
    }, info() {}, warning() {}, error(message) { assert.fail(message); },
  }, coordinator(async (publish) => {
    const sessions: NativeSession[] = [];
    for (let index = 0; index < 500; index++) {
      sessions.push(session(index)); publish?.([...sessions]);
    }
    return sessions;
  }));
  await command?.();
  assert.equal(sizes.find((size) => size > 0), 1, "first useful row should publish immediately");
  assert.equal(sizes.at(-1), 500, "final result must not lose sessions");
  assert(sizes.length <= 2, `Expected first and final refresh, received ${sizes.length}`);
});
