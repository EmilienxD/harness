import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileAgentMcpConfigs } from "../src/bridge/mcp-config.js";

test("role-scoped MCP credentials are resolved per agent and can be cleared independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-agent-mcp-"));
  const configs = new FileAgentMcpConfigs(root);
  const first = await configs.write({ port: 4823, token: "activation-token", agentId: "brain-1" });
  const second = await configs.write({ port: 4823, token: "activation-token", agentId: "brain-2" });
  assert.notEqual(first, second);
  const document = JSON.parse(await readFile(first, "utf8")) as { mcpServers: { aboard: { url: string; headers: Record<string, string> } } };
  assert.equal(document.mcpServers.aboard.url, "http://127.0.0.1:4823/mcp");
  assert.equal(document.mcpServers.aboard.headers.Authorization, "Bearer activation-token");
  assert.equal(document.mcpServers.aboard.headers["X-Aboard-Agent-Id"], "brain-1");
  await configs.clear("brain-1");
  await assert.rejects(access(first));
  await access(second);
  await configs.clearAll();
  await assert.rejects(access(second));
});

test("an agent id cannot escape resolved MCP storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-agent-mcp-"));
  const configs = new FileAgentMcpConfigs(root);
  await assert.rejects(configs.write({ port: 4823, token: "secret", agentId: "../escape" }), /Unsafe agent id/u);
});
