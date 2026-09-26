import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackgroundProcess } from "../../src/platform/background.js";
import { buildCommandLine } from "../../src/platform/shell.js";

test("detached background adapter executes its command and captures output", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-background-"));
  const shell = process.platform === "win32" ? "powershell" : "git-bash";
  let ended!: () => void;
  const completion = new Promise<void>((resolve) => { ended = resolve; });
  const handle = createBackgroundProcess({ cwd: root, env: { ABOARD_RUNTIME_ROOT: root, ABOARD_EXECUTION_ID: "test-execution" } }, shell, () => ended());
  const timeout = setTimeout(() => handle.dispose(), 10_000);
  try {
    handle.sendText(buildCommandLine(shell, [process.execPath], ["-e", "process.stdout.write('background-complete')"]), true);
    await completion;
    assert.equal(handle.exitStatus?.code, 0);
    assert.equal(await readFile(join(root, "executions", "test-execution", "stdout.jsonl"), "utf8"), "background-complete");
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true });
  }
});

test("Harness delegation writes a watchable log and a fleet lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-watch-"));
  const shell = process.platform === "win32" ? "powershell" : "git-bash";
  const executionId = "550e8400-e29b-41d4-a716-446655440000";
  let ended!: () => void;
  const completion = new Promise<void>((resolve) => { ended = resolve; });
  const handle = createBackgroundProcess({ cwd: root, env: { ABOARD_RUNTIME_ROOT: root, ABOARD_AGENT_ID: "agent-1", HARNESS_STATE_DIR: root, HARNESS_EXECUTION_ID: executionId } }, shell, () => ended());
  const timeout = setTimeout(() => handle.dispose(), 10_000);
  try {
    handle.sendText(buildCommandLine(shell, [process.execPath], ["-e", "process.stdout.write('watchable')"]), true);
    await completion;
    assert.equal(await readFile(join(root, "runtime", "watch", executionId, "stdout.jsonl"), "utf8"), "watchable");
    const pointer = JSON.parse(await readFile(join(root, "watch", "agent-1.json"), "utf8")) as { log: string };
    assert.equal(pointer.log, join(root, "runtime", "watch", executionId, "stdout.jsonl"));
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true });
  }
});
