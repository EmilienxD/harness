import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { killProcessTree, runSubagentsJourney, runSubagentsRecoveryJourney, runSubagentsRootJourney } from "../tools/subagents/run.js";
import { parseAnthropicMessagesRequest } from "../core/anthropic-protocol.js";
import { startFakeAnthropicServer } from "../core/anthropic-server.js";
import { startFakeOpenAiServer } from "../core/openai-server.js";
import { claudeTransition, codexTransition, scenarioCatalogHash } from "../tools/subagents/scenario.js";

test("owned CLI teardown tolerates an already-exited process without relying on taskkill status codes", { skip: process.platform !== "win32" }, async () => {
  const child = spawnSync(process.execPath, ["-e", ""], { windowsHide: true, timeout: 5_000 });
  assert.equal(child.status, 0);
  assert.ok(child.pid);
  await assert.doesNotReject(killProcessTree(child.pid, true));
});

test("interactive bridge completion is published only by its terminal driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-bridge-completion-e2e-"));
  try {
    const native = join(root, "native.cjs");
    await writeFile(native, 'process.stdout.write("bridge-complete");');
    const bridge = resolve("dist/tools/subagents/cli-bridge.js");
    const options = {
      env: { ...process.env, HARNESS_EXECUTION_MODE: "interactive", HARNESS_REQUEST_ID: "fixture-child", HARNESS_E2E_CLI_DIR: root, HARNESS_E2E_CHILD_COMPLETE: "bridge-complete" },
      windowsHide: true, timeout: 5_000,
    };
    const provider = spawnSync(process.execPath, [bridge, "--provider", "chatgpt", process.execPath, native], options);
    assert.equal(provider.status, 0);
    assert.equal(JSON.parse(await readFile(join(root, `child-${provider.pid}.json`), "utf8")).status, "completed");
    await assert.rejects(readFile(join(root, "child.json")), { code: "ENOENT" });
    const terminal = spawnSync(process.execPath, [bridge, "--drive", process.execPath, native], options);
    assert.equal(terminal.status, 0);
    assert.equal(JSON.parse(await readFile(join(root, "child.json"), "utf8")).status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic Codex SessionEnd cannot discard the supervisor's successful reply", { timeout: 180_000 }, async () => {
  const result = await runSubagentsJourney("chatgpt", "auto", false, false, { shutdownBeforeResult: true });
  assert.equal(result.shutdownsBeforeResult, 2);
  assert.equal(result.inferenceRequests, 6);
  assert.deepEqual(result.completedClis, ["child", "parent"]);
  assert.equal(result.requestFilesRemaining, 0);
  assert.equal(result.unexpectedRequests, 0);
});

for (const platform of ["claude", "chatgpt"] as const) {
  test(`a failed shell command still submits its request through real ${platform} CLIs`, { timeout: 180_000 }, async () => {
    const result = await runSubagentsJourney(platform, "auto", false, false, { failedWrite: true });
    assert.deepEqual(result.completedClis, ["child", "parent"]);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
  test(`Stop discovers a shell-created request through real ${platform} CLIs without PostToolUse`, { timeout: 180_000 }, async () => {
    const result = await runSubagentsJourney(platform, "auto", false, false, { stopFallback: true });
    assert.deepEqual(result.completedClis, ["child", "parent"]);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
    assert.ok(result.checkpoints.includes("parent-waiting"));
    assert.ok(result.checkpoints.includes("parent-received-reply"));
  });
  test(`subagents rejects unknown ${platform} histories at its fake API`, async () => {
    const server = platform === "claude"
      ? await startFakeAnthropicServer({ repoRoot: process.cwd(), scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition: claudeTransition })
      : await startFakeOpenAiServer({ scenarioCatalogHash, transition: (request) => codexTransition(request, process.cwd()) });
    try {
      const request = platform === "claude"
        ? { model: "e2e", max_tokens: 32, stream: true, messages: [{ role: "user", content: "Unrecognized fixture history." }], tools: [] }
        : { model: "e2e", stream: true, store: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Unrecognized fixture history." }] }], tools: [] };
      const response = await fetch(`${server.baseUrl}${platform === "claude" ? "/v1/messages" : "/responses"}`, {
        method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${server.authToken}` }, body: JSON.stringify(request),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 400);
      assert.equal(server.assertions().unexpectedRequests, 1);
      assert.deepEqual(server.assertions().checkpoints, []);
    } finally { await server.close(); }
  });
  test(`subagents releases a waiting parent after killing its interactive child through real ${platform} CLIs`, { timeout: 120_000 }, async () => {
    const result = await runSubagentsJourney(platform, "interactive", true, false, { killChildWhileWaiting: true });
    assert.deepEqual(result.completedClis, ["parent"]);
    assert.equal(result.inferenceRequests, 6);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
  test(`subagents resumes a killed parent and child through real ${platform} CLIs`, { timeout: 240_000 }, async () => {
    const result = await runSubagentsRecoveryJourney(platform);
    assert.equal(result.recoveredSessions, 2);
    assert.deepEqual(result.completedClis, ["child", "parent"]);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
  test(`subagents starts and resumes a child in another worktree root through real ${platform} CLIs`, { timeout: 180_000 }, async () => {
    const result = await runSubagentsRootJourney(platform);
    assert.deepEqual(result.completedClis, ["child", "parent"]);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
 for (const mode of ["interactive","auto"] as const) {
  test(`subagents delegates and explicitly replies through real ${platform} ${mode} CLIs`, { timeout: 180_000 }, async () => {
    const result = await runSubagentsJourney(platform,mode);
    assert.deepEqual(result.checkpoints.filter((item) => item !== "parent-waiting").sort(), ["child-complete", ...(mode === "interactive" ? ["child-reply-armed", "child-resume-reply-armed"] : []), "child-resume-complete", "parent-inbox-enable", "parent-received-reply", "parent-request-write"].sort());
    assert.deepEqual(result.completedClis, ["child", "parent"]);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
}

}
