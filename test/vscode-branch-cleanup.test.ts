import assert from "node:assert/strict";
import test from "node:test";

import { registerBranchCleanupCommand } from "../src/vscode/branch-cleanup.js";

test("branch cleanup discovers first and mutates only after Clear", async () => {
  let callback: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const cleanup = {
    discover: async () => { calls.push("discover"); return { defaultBranch: "main", branches: [{ name: "aboard/1-x", localSha: "a", ahead: 1, behind: 0 }], pullRequests: [] }; },
    clear: async () => { calls.push("clear"); return { deletedLocal: ["aboard/1-x"], deletedRemote: [], retained: [] }; },
  };
  registerBranchCleanupCommand({
    registerCommand: (_command, registered) => { callback = registered; return { dispose() {} }; },
    progress: async (title, task) => { calls.push(`progress ${title}`); return task(); },
    confirm: async (_message, detail) => { calls.push(`preview ${detail.includes("local only")}`); return "Clear"; },
    info: (message) => calls.push(`info ${message}`),
    error: (message) => assert.fail(message),
  }, cleanup as never);
  await callback!();
  assert.deepEqual(calls, [
    "progress Checking aboard branches…",
    "discover",
    "preview true",
    "progress Clearing aboard branches…",
    "clear",
    "info Aboard branch cleanup finished; removed local aboard/1-x.",
  ]);
});

test("Cancel leaves every branch untouched", async () => {
  let callback: (() => Promise<void>) | undefined;
  let cleared = false;
  registerBranchCleanupCommand({
    registerCommand: (_command, registered) => { callback = registered; return { dispose() {} }; },
    progress: async (_title, task) => task(),
    confirm: async () => undefined,
    info: () => undefined,
    error: (message) => assert.fail(message),
  }, {
    discover: async () => ({ defaultBranch: "main", branches: [{ name: "aboard/1-x", localSha: "a", ahead: 0, behind: 0 }], pullRequests: [] }),
    clear: async () => { cleared = true; return { deletedLocal: [], deletedRemote: [], retained: [] }; },
  } as never);
  await callback!();
  assert.equal(cleared, false);
});
