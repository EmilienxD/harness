import assert from "node:assert/strict";
import test from "node:test";

import { runRemoveAnthropicCoauthorJourney } from "../tools/remove-anthropic-coauthor/run.js";
import { startFakeAnthropicServer } from "../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../core/anthropic-protocol.js";
import { MARKER, scenarioCatalogHash, transition } from "../tools/remove-anthropic-coauthor/scenario.js";

test("real Claude CLI commits in an isolated repository lose only Claude attribution", { timeout: 180_000 }, async () => {
  const result = await runRemoveAnthropicCoauthorJourney();
  assert.deepEqual(result.checkpoints, ["commit-opus", "commit-sonnet", "complete"]);
  assert.deepEqual(result.messages, [
    "Sonnet fixture\n\nCo-Authored-By: Alice <alice@example.invalid>",
    "Opus fixture\n\nCo-Authored-By: Alice <alice@example.invalid>",
  ]);
  assert.equal(result.committedBytes, "sonnet committed\n");
  assert.equal(result.stagedChangesPreserved, true);
  assert.equal(result.commitMetadataPreserved, true);
  assert.equal(result.originalTrailersPresent, true);
  assert.equal(result.unexpectedRequests, 0);
  assert.equal(result.inferenceRequests, 3);
});

test("coauthor endpoint rejects unexpected histories deterministically without leaking input", async () => {
  const server = await startFakeAnthropicServer({
    repoRoot: process.cwd(), scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition,
  });
  try {
    const body = JSON.stringify({
      model: "e2e-fixture", max_tokens: 100, tools: [{ name: "Bash" }], messages: [
        { role: "user", content: MARKER },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_e2e_remove_coauthor_opus", name: "Bash", input: { command: "private-fixture-escape-command" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_remove_coauthor_opus", content: "private-tool-result" }] },
      ],
    });
    const errors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${server.baseUrl}/v1/messages`, {
        method: "POST", headers: { authorization: `Bearer ${server.authToken}`, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body,
      });
      assert.equal(response.status, 400);
      errors.push(await response.text());
    }
    assert.equal(errors[0], errors[1]);
    const diagnostics = JSON.stringify(server.assertions().observations);
    assert.doesNotMatch(errors.join("\n") + diagnostics, /private-fixture-escape-command|private-tool-result|toolu_e2e_remove_coauthor_opus/u);
    assert.equal(server.assertions().unexpectedRequests, 2);
    assert.deepEqual(server.assertions().checkpoints, []);
  } finally {
    await server.close();
  }
});
