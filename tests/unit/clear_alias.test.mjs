import assert from "node:assert/strict";
import test from "node:test";
import register from "../../harness/productivity/clear-alias/pi/extension.ts";

function loadCommand() {
  const commands = new Map();
  register({ registerCommand: (name, command) => commands.set(name, command) });
  assert.deepEqual([...commands.keys()], ["clear"]);
  return commands.get("clear");
}

test("/clear awaits native newSession without options or inference", async () => {
  const command = loadCommand();
  let calls = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let settled = false;
  const execution = command.handler("", {
    newSession: async (...args) => {
      assert.deepEqual(args, []);
      calls++;
      await pending;
      return { cancelled: false };
    },
  }).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(settled, false);
  finish();
  await execution;
  assert.equal(settled, true);
});

test("native cancellation is respected without retry or follow-up", async () => {
  let calls = 0;
  await loadCommand().handler("", {
    newSession: async () => { calls++; return { cancelled: true }; },
  });
  assert.equal(calls, 1);
});

test("native session errors propagate", async () => {
  const error = new Error("session creation failed");
  await assert.rejects(loadCommand().handler("", {
    newSession: async () => { throw error; },
  }), (caught) => caught === error);
});
