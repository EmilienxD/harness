import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const WRAPPER = join(process.cwd(), "assets", "scaffold", ".aboard", "scripts", "aboard_wrapper.py");

function uv(args: readonly string[], options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("uv", ["run", "--no-project", "python", ...args], { input: options.input, encoding: "utf8", env: options.env });
}

test("wrapper owns the marker for exactly the child's lifetime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-"));
  const lock = join(root, "locks", "a1.lock");
  // A child that sleeps: the marker must exist while it runs and vanish the
  // moment it exits, whatever the exit reason.
  const child = spawn("uv", ["run", "--no-project", "python", WRAPPER, lock, "--", process.execPath, "-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(lock)) {
      if (Date.now() > deadline) throw new Error("marker was not created");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const marker = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
    assert.equal(typeof marker.wrapperPid, "number");
    assert.equal(typeof marker.childPid, "number");
    assert.equal(marker.agentId, null);

    // exit code, killed child, crashed child: every ending removes the marker.
    const killed = JSON.parse(readFileSync(lock, "utf8")) as { childPid: number };
    process.kill(killed.childPid);
    const closed = await new Promise<number | null>((resolve) => child.once("close", resolve));
    assert.equal(typeof closed, "number");
    assert.equal(existsSync(lock), false);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper exits 2 on a malformed invocation and never touches the marker", () => {
  const result = uv([WRAPPER, "only-lock-path"]);
  assert.equal(result.status, 2);
});

test("wrapper returns the child's exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-"));
  const lock = join(root, "a.lock");
  try {
    const ok = uv([WRAPPER, lock, "--", process.execPath, "-e", "process.exit(0)"]);
    assert.equal(ok.status, 0);
    assert.equal(existsSync(lock), false);
    const bad = uv([WRAPPER, lock, "--", process.execPath, "-e", "process.exit(7)"]);
    assert.equal(bad.status, 7);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
