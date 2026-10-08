import assert from "node:assert/strict";
import test from "node:test";
import { startFakeAnthropicServer } from "../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../core/anthropic-protocol.js";
import { startFakeOpenAiServer } from "../core/openai-server.js";
import { claudeTransition, codexTransition, scenarioCatalogHash } from "../tools/ship/scenario.js";

test("ship rejects unknown Claude histories without invoking a tool", async () => {
  const server = await startFakeAnthropicServer({ repoRoot: process.cwd(), scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest,
    transition: (request, root) => claudeTransition(request, root, "feedback", "python") });
  try {
    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${server.authToken}` },
      body: JSON.stringify({ model: "e2e", max_tokens: 32, stream: true, messages: [{ role: "user", content: "Unknown history" }], tools: [] }),
    });
    await response.arrayBuffer();
    assert.equal(response.status, 400);
    assert.equal(server.assertions().unexpectedRequests, 1);
    assert.deepEqual(server.assertions().checkpoints, []);
  } finally { await server.close(); }
});

test("ship rejects unknown Codex histories without invoking a tool", async () => {
  const server = await startFakeOpenAiServer({ scenarioCatalogHash, transition: (request) => codexTransition(request, process.cwd(), "feedback", "python") });
  try {
    const response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${server.authToken}` },
      body: JSON.stringify({ model: "e2e", stream: true, store: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Unknown history" }] }], tools: [] }),
    });
    await response.arrayBuffer();
    assert.equal(response.status, 400);
    assert.equal(server.assertions().unexpectedRequests, 1);
    assert.deepEqual(server.assertions().checkpoints, []);
  } finally { await server.close(); }
});
