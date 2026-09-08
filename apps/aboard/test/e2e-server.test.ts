import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SCENARIO_MARKER } from "../e2e/scenario.js";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../e2e/server.js";

function body(stream = false): Record<string, unknown> {
  return {
    model: "claude-e2e",
    max_tokens: 1000,
    messages: [{ role: "user", content: [{ type: "text", text: `${SCENARIO_MARKER} private-prompt` }] }],
    stream,
    tools: [{ name: "Read" }, { name: "Edit" }],
  };
}

function headers(server: FakeAnthropicServer): Record<string, string> {
  return { authorization: `Bearer ${server.authToken}`, "anthropic-version": "2023-06-01", "content-type": "application/json" };
}

test("fake server binds IPv4 loopback on an ephemeral port and exposes a minimal readiness record", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-e2e-server-"));
  const readinessPath = join(root, "readiness.json");
  const server = await startFakeAnthropicServer({ repoRoot: root, readinessPath });
  try {
    const url = new URL(server.baseUrl);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(Number(url.port) > 0);
    const readiness = JSON.parse(await readFile(readinessPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(readiness).sort(), ["port", "processId", "protocolVersion", "scenarioCatalogHash"]);
    assert.equal(readiness.port, Number(url.port));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HEAD hello is unauthenticated while every JSON route requires only the dummy bearer", async () => {
  const server = await startFakeAnthropicServer({ repoRoot: tmpdir() });
  try {
    assert.equal((await fetch(`${server.baseUrl}/api/hello`, { method: "HEAD" })).status, 204);
    assert.equal((await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body()) })).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: { ...headers(server), "x-api-key": "forbidden" }, body: JSON.stringify(body()) })).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: { ...headers(server), "anthropic-version": "future" }, body: JSON.stringify(body()) })).status, 400);
    const missingType = { ...headers(server) };
    delete missingType["content-type"];
    assert.equal((await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: missingType, body: JSON.stringify(body()) })).status, 400);
  } finally {
    await server.close();
  }
});

test("unknown methods endpoints and invalid JSON fail closed with deterministic sanitized ids", async () => {
  const server = await startFakeAnthropicServer({ repoRoot: tmpdir() });
  try {
    assert.equal((await fetch(`${server.baseUrl}/v1/messages`, { method: "GET" })).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/v1/unknown`, { method: "POST" })).status, 404);
    const first = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: headers(server), body: "private-invalid-json" });
    const second = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: headers(server), body: "different-invalid-json" });
    const firstJson = await first.json() as { error: { message: string }; request_id: string };
    const secondJson = await second.json() as { error: { message: string }; request_id: string };
    assert.equal(first.status, 400);
    assert.equal(firstJson.error.message, "request body is not valid JSON");
    assert.equal(firstJson.request_id, secondJson.request_id);
    assert.doesNotMatch(JSON.stringify(firstJson), /private-invalid-json/u);
  } finally {
    await server.close();
  }
});

test("message query parameters preserve routing and aggregate Messages structure", async () => {
  const server = await startFakeAnthropicServer({ repoRoot: tmpdir() });
  try {
    const response = await fetch(`${server.baseUrl}/v1/messages?beta=true&future=1`, { method: "POST", headers: { ...headers(server), "anthropic-beta": "future-beta,current-beta", "x-future-header": "accepted" }, body: JSON.stringify(body()) });
    assert.equal(response.status, 200);
    const message = await response.json() as Record<string, unknown>;
    assert.equal(message.type, "message");
    assert.equal(message.role, "assistant");
    assert.equal(message.stop_reason, "tool_use");
    assert.equal(message.stop_sequence, null);
    assert.ok(Array.isArray(message.content));
    assert.equal(typeof message.usage, "object");
  } finally {
    await server.close();
  }
});

test("fake server resolves the active repository root for each inference", async () => {
  const originalRoot = join(tmpdir(), "aboard-e2e-original");
  const activeRoot = join(tmpdir(), "aboard-e2e-active");
  let resolutions = 0;
  const server = await startFakeAnthropicServer({
    repoRoot: originalRoot,
    resolveRepoRoot: async () => {
      resolutions += 1;
      return activeRoot;
    },
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: headers(server), body: JSON.stringify(body()) });
    const message = await response.json() as { content: Array<{ input?: { file_path?: string } }> };
    assert.equal(response.status, 200);
    assert.equal(resolutions, 1);
    assert.equal(message.content[0]?.input?.file_path, join(activeRoot, "deterministic.txt"));
  } finally {
    await server.close();
  }
});

test("count_tokens accepts its reduced shape without advancing a scenario", async () => {
  const server = await startFakeAnthropicServer({ repoRoot: tmpdir() });
  try {
    const response = await fetch(`${server.baseUrl}/v1/messages/count_tokens`, { method: "POST", headers: headers(server), body: JSON.stringify({ model: "claude-e2e", messages: [{ role: "user", content: "count this" }] }) });
    assert.deepEqual(await response.json(), { input_tokens: 1000 });
    const state = server.assertions();
    assert.equal(state.tokenCountRequests, 1);
    assert.equal(state.inferenceRequests, 0);
    assert.deepEqual(state.checkpoints, []);
  } finally {
    await server.close();
  }
});

test("streaming emits exact Anthropic event order and typed deltas without DONE", async () => {
  const server = await startFakeAnthropicServer({ repoRoot: tmpdir() });
  try {
    const response = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: headers(server), body: JSON.stringify(body(true)) });
    const value = await response.text();
    assert.deepEqual([...value.matchAll(/^event: (.+)$/gm)].map((match) => match[1]), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    assert.match(value, /"type":"input_json_delta"/u);
    assert.doesNotMatch(value, /\[DONE\]/u);
  } finally {
    await server.close();
  }
});

test("closing persists structural observations with forbidden upstream and no sensitive content", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-e2e-server-"));
  const diagnosticsPath = join(root, "diagnostics.json");
  const server = await startFakeAnthropicServer({ repoRoot: root, diagnosticsPath });
  const privateSession = "private-session-id";
  try {
    await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: { ...headers(server), "x-claude-code-session-id": privateSession, cookie: "private-cookie" }, body: JSON.stringify(body()) });
  } finally {
    await server.close();
  }
  const diagnostics = await readFile(diagnosticsPath, "utf8");
  assert.match(diagnostics, /"upstreamMode": "forbidden"/u);
  assert.match(diagnostics, /"checkpoint": "read-target"/u);
  for (const secret of [server.authToken, privateSession, "private-cookie", "private-prompt", SCENARIO_MARKER, "deterministic.txt"]) {
    assert.doesNotMatch(diagnostics, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
  await rm(root, { recursive: true, force: true });
});

test("starting a server clears stale structural observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-e2e-server-"));
  const diagnosticsPath = join(root, "diagnostics.json");
  await writeFile(diagnosticsPath, '{"observations":[{"checkpoint":"stale"}]}\n');
  const server = await startFakeAnthropicServer({ repoRoot: root, diagnosticsPath });
  try {
    const value = JSON.parse(await readFile(diagnosticsPath, "utf8")) as { observations: unknown[] };
    assert.deepEqual(value.observations, []);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
