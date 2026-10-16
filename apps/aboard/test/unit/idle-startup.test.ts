import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { waitForIdleProviderStartup, IdleProviderStartupUncertainError } from "../../src/runtime/idle-startup.js";

test("an idle provider needs a live child process, not just a terminal or wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-idle-startup-"));
  const lock = join(root, "agent.lock");
  try {
    await writeFile(lock, JSON.stringify({ wrapperPid: process.pid, childPid: null }));
    await assert.rejects(waitForIdleProviderStartup(lock, () => true, 40, 10), IdleProviderStartupUncertainError);
    await writeFile(lock, JSON.stringify({ wrapperPid: process.pid, childPid: process.pid }));
    await waitForIdleProviderStartup(lock, () => true, 200, 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed provider spawn is reported even while its terminal remains open", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-idle-startup-"));
  const lock = join(root, "agent.lock");
  try {
    await writeFile(join(root, "agent.exit"), JSON.stringify({ exitCode: 127, error: "command missing" }));
    await assert.rejects(waitForIdleProviderStartup(lock, () => true, 100, 10), /command missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
