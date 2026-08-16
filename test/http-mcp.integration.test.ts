import assert from "node:assert/strict";
import test from "node:test";

import { createMcpHandler } from "../src/bridge/mcp.js";
import { startBridge } from "../src/bridge/server.js";
import type { BridgeDiscoveryPersistence } from "../src/bridge/discovery.js";
import type { AgentId } from "../src/domain/contracts.js";

const managerAgentId = "manager-1" as AgentId;
const persistence: BridgeDiscoveryPersistence = {
  write: async () => undefined,
  clear: async () => undefined,
};

async function rpc(
  port: number,
  token: string,
  agentId: string | undefined,
  method: string,
  params?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(agentId === undefined ? {} : { "x-aboard-agent-id": agentId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: response.status, body: await response.json() as unknown };
}

test("serves the MCP protocol over authenticated loopback HTTP to the Manager only", async (context) => {
  const bridge = await startBridge({
    preferredPort: 0,
    persistence,
    tokenFactory: () => "activation-token",
    handler: createMcpHandler({
      run: async () => ({ result: "done" }),
      spawn: async () => ({ status: "running" }),
      spawnInteractive: async () => ({ handoff: "open" }),
      releaseLease: (reason) => ({ released: true, reason }),
    }, { managerAgentId }),
  });
  context.after(() => bridge.stop());

  const initialized = await rpc(bridge.port, bridge.token, managerAgentId, "initialize", {});
  assert.equal(initialized.status, 200);
  assert.equal((initialized.body as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name, "aboard");

  const listed = await rpc(bridge.port, bridge.token, managerAgentId, "tools/list", {});
  assert.deepEqual(
    (listed.body as { result?: { tools?: Array<{ name: string }> } }).result?.tools?.map((tool) => tool.name),
    ["run_agent", "todo_create", "todo_update", "start_auto_run", "review_pr", "release_lease"],
  );

  const called = await rpc(bridge.port, bridge.token, managerAgentId, "tools/call", {
    name: "release_lease",
    arguments: { reason: "operator recovery" },
  });
  assert.deepEqual(
    (called.body as { result?: { structuredContent?: unknown } }).result?.structuredContent,
    { released: true, reason: "operator recovery" },
  );

  assert.equal((await rpc(bridge.port, bridge.token, "worker-1", "tools/list", {})).status, 403);
  assert.equal((await rpc(bridge.port, bridge.token, undefined, "tools/list", {})).status, 403);
});
