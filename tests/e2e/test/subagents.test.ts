import assert from "node:assert/strict";
import test from "node:test";

import { runSubagentsJourney, runSubagentsRecoveryJourney, runSubagentsRootJourney } from "../tools/subagents/run.js";
import { parseAnthropicMessagesRequest } from "../core/anthropic-protocol.js";
import { startFakeAnthropicServer } from "../core/anthropic-server.js";
import { startFakeOpenAiServer } from "../core/openai-server.js";
import { claudeTransition, codexTransition, scenarioCatalogHash } from "../tools/subagents/scenario.js";

test("automatic Codex SessionEnd cannot discard the supervisor's successful reply", { timeout: 180_000 }, async () => {
  const result = await runSubagentsJourney("chatgpt", "auto", false, false, { shutdownBeforeResult: true });
  assert.equal(result.shutdownsBeforeResult, 2);
  assert.equal(result.inferenceRequests, 5);
  assert.deepEqual(result.completedClis, ["child", "parent"]);
  assert.equal(result.requestFilesRemaining, 0);
  assert.equal(result.unexpectedRequests, 0);
});

for (const platform of ["claude", "chatgpt"] as const) {
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
    assert.deepEqual(result.checkpoints.filter((item) => item !== "parent-waiting").sort(), ["child-complete", ...(mode === "interactive" ? ["child-reply-armed", "child-resume-reply-armed"] : []), "child-resume-complete", "parent-received-reply", "parent-request-write"].sort());
    assert.deepEqual(result.completedClis, ["child", "parent"]);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
}

}
