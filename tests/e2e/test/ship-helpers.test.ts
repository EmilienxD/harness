import assert from "node:assert/strict";
import test from "node:test";
import { startFakeOpenAiServer } from "../core/openai-server.js";
import { runShipHelpersJourney } from "../tools/ship-helpers/run.js";
import { helpersScenario, scenarioCatalogHash } from "../tools/ship-helpers/scenario.js";

test("ship helper scenario rejects unknown histories without running a command", async () => {
  const server = await startFakeOpenAiServer({ scenarioCatalogHash, transition: helpersScenario([]) });
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

test("real Codex executes pinned ship helpers without installing them and preserves the persistent runtime", { timeout: 180_000 }, async () => {
  await runShipHelpersJourney();
});
