import assert from "node:assert/strict";
import test from "node:test";

import { createMcpHandler } from "../src/bridge/mcp.js";
import { startBridge } from "../src/bridge/server.js";
import type { BridgeDiscoveryPersistence } from "../src/bridge/discovery.js";

const persistence: BridgeDiscoveryPersistence = { write: async () => undefined, clear: async () => undefined };

test("authenticated HTTP crosses the MCP boundary and validates requests", async (context) => {
  const calls: Array<{ type: string; description: string }> = [];
  const mcp = createMcpHandler({
    run: async (input) => { calls.push({ type: input.type, description: input.description }); return { agentId: "worker-1", result: { outcome: "succeeded", exitCode: 0, lastAssistantMessage: "reviewed", telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 } } }; },
    spawn: () => { throw new Error("not used"); },
    // `raw` and `brainstormer` are interactive-only, so a launch that omits the
    // flag is coerced onto this path rather than refused.
    spawnInteractive: async (input) => { calls.push({ type: input.type, description: input.description }); return { agentId: "worker-1", handoff: "Terminal focused." }; },
    releaseLease: () => ({ released: false }),
  });
  const bridge = await startBridge({ preferredPort: 0, persistence, tokenFactory: () => "integration-token", handler: mcp });
  context.after(() => bridge.stop());

  const invoke = (token: string, body: unknown) => fetch(`http://127.0.0.1:${bridge.port}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await invoke("wrong", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
  const invalid = await invoke(bridge.token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_agent", arguments: { type: "raw", description: "open a raw session now", prompt: "" } } });
  assert.equal(invalid.status, 200);
  assert.match(await invalid.text(), /prompt must be a non-empty string/);
  const valid = await invoke(bridge.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_agent", arguments: { type: "brainstormer", description: "brainstorm the current changes", prompt: "The current changes" } } });
  assert.equal(valid.status, 200);
  assert.match(await valid.text(), /worker-1/);
  assert.deepEqual(calls, [{ type: "brainstormer", description: "brainstorm the current changes" }]);
});
