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
