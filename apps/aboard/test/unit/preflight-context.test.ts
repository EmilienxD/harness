import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCommandRunner } from "../../src/platform/preflight.js";
import { ClaudeCommandProbe } from "../../src/claude/preflight.js";
import { ChatGptCommandProbe } from "../../src/chatgpt/preflight.js";

test("real command probes execute in the selected checkout with its environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "checkout");
  await mkdir(target);
  const run = spawnCommandRunner(root);
  const result = await run(process.execPath, ["-p", "JSON.stringify([process.cwd(),process.env.ABOARD_CONTEXT_TEST])"], 10000, { cwd: target, env: { ABOARD_CONTEXT_TEST: "target" } });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), [target, "target"]);
});

test("provider command caches distinguish checkout and environment", async () => {
  for (const Probe of [ClaudeCommandProbe, ChatGptCommandProbe]) {
    let calls = 0;
    const probe = new Probe({ run: async (_program, _args, _timeout, context) => { calls++; return { code: 0, stdout: context?.cwd ?? "default", stderr: "" }; } });
    await probe.require(["wrapper"], { cwd: "source" });
    await probe.require(["wrapper"], { cwd: "target" });
    await probe.require(["wrapper"], { cwd: "target" });
    await probe.require(["wrapper"], { cwd: "target", env: { MODEL: "other" } });
    assert.equal(calls, 3);
  }
});
