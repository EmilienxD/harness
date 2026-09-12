import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { BRIDGE_HOST, startBridge } from "../../src/bridge/server.js";

async function request(
  port: number,
  path: string,
  token?: string,
  body?: string,
): Promise<{ status: number; body: unknown }> {
  const options: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
  };
  const response = await fetch(`http://${BRIDGE_HOST}:${port}${path}`, options);
  return { status: response.status, body: await response.json() as unknown };
}

test("binds to IPv4 loopback and authenticates every route", async (context) => {
  const bridge = await startBridge({
    preferredPort: 0,
    tokenFactory: () => "activation-token",
    handler: (incoming) => ({ status: 200, body: { path: incoming.url.pathname } }),
  });
  context.after(() => bridge.stop());

  assert.equal(bridge.host, "127.0.0.1");
  assert.equal((await request(bridge.port, "/hook")).status, 401);
  assert.equal((await request(bridge.port, "/unknown", "wrong-token")).status, 401);
  assert.deepEqual(await request(bridge.port, "/unknown", bridge.token), {
    status: 200,
    body: { path: "/unknown" },
  });
});

test("rotates tokens between activations", async () => {
  const first = await startBridge({
    preferredPort: 0,
    handler: () => ({ status: 204 }),
  });
  const second = await startBridge({
    preferredPort: 0,
    handler: () => ({ status: 204 }),
  });
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(first.token, uuidV4);
  assert.match(second.token, uuidV4);
  assert.notEqual(first.token, second.token);
  await Promise.all([first.stop(), second.stop()]);
});

test("the command token opens the command endpoint and nothing else", async (context) => {
  let calls = 0;
  const bridge = await startBridge({
    preferredPort: 0,
    tokenFactory: () => "full-token",
    commandTokenFactory: () => "command-token",
    handler: (incoming) => { calls += 1; return { status: 200, body: { path: incoming.url.pathname } }; },
  });
  context.after(() => bridge.stop());

  assert.notEqual(bridge.commandToken, bridge.token);
  for (const path of ["/commands", "/commands/abc/show"]) {
    assert.deepEqual(await request(bridge.port, path, bridge.commandToken), { status: 200, body: { path } });
  }
  // A discoverable credential must not reach the agent surface: no launches, no
  for (const path of ["/terminals", "/unknown", "/hook", "/sessions", "/commandsandmore"]) {
    const refused = await request(bridge.port, path, bridge.commandToken);
    assert.equal(refused.status, 403, path);
    assert.deepEqual(refused.body, { ok: false, error: { code: "forbidden", message: "This credential does not authorize this endpoint" } });
  }
  assert.equal(calls, 2, "a refused request never reaches the handler");
  // The full token keeps reaching everything, including the command endpoint.
  assert.equal((await request(bridge.port, "/commands", bridge.token)).status, 200);
  assert.equal((await request(bridge.port, "/terminals", bridge.token)).status, 200);
});

test("the delegation token reaches only the delegation endpoint", async (context) => {
  const bridge = await startBridge({
    preferredPort: 0,
    tokenFactory: () => "full-token",
    commandTokenFactory: () => "command-token",
    delegationTokenFactory: () => "delegation-token",
    handler: (incoming) => ({ status: 200, body: { path: incoming.url.pathname } }),
  });
  context.after(() => bridge.stop());

  assert.equal((await request(bridge.port, "/delegations", bridge.delegationToken, "{}")).status, 200);
  for (const path of ["/commands", "/terminals", "/hooks/stop", "/delegations/extra"]) {
    assert.equal((await request(bridge.port, path, bridge.delegationToken, "{}")).status, 403, path);
  }
});

test("rotates the command token between activations and never logs it", async (context) => {
  const messages: string[] = [];
  const first = await startBridge({
    preferredPort: 0,
    commandTokenFactory: () => "never-log-this-command-token",
    logger: { info: () => undefined, error: (message) => messages.push(message) },
    handler: () => { throw new Error("never-log-this-command-token"); },
  });
  context.after(() => first.stop());
  const second = await startBridge({ preferredPort: 0, handler: () => ({ status: 204 }) });
  context.after(() => second.stop());

  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(second.commandToken, uuidV4);
  assert.notEqual(first.commandToken, second.commandToken);

  const response = await request(first.port, "/commands", first.commandToken);
  assert.equal(response.status, 500);
  assert.equal(messages.join("\n").includes(first.commandToken), false);
  assert.equal(JSON.stringify(response.body).includes(first.commandToken), false);
});

test("falls back to an ephemeral port when the preferred port is occupied", async (context) => {
  const occupyingServer = createServer();
  await new Promise<void>((resolve) => occupyingServer.listen(0, BRIDGE_HOST, resolve));
  context.after(() => new Promise<void>((resolve) => occupyingServer.close(() => resolve())));
  const address = occupyingServer.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") return;

  const bridge = await startBridge({
    preferredPort: address.port,
    handler: () => ({ status: 204 }),
  });
  context.after(() => bridge.stop());
  assert.notEqual(bridge.port, address.port);
});

test("rejects malformed JSON without invoking the handler", async (context) => {
  let calls = 0;
  const bridge = await startBridge({
    preferredPort: 0,
    tokenFactory: () => "secret-token",
    handler: () => {
      calls += 1;
      return { status: 204 };
    },
  });
  context.after(() => bridge.stop());

  const result = await request(bridge.port, "/hook", bridge.token, "{");
  assert.equal(result.status, 400);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(result.body).includes(bridge.token), false);
});

test("shutdown aborts pending long polls", async () => {
  let observedStart!: () => void;
  const started = new Promise<void>((resolve) => { observedStart = resolve; });
  let observedAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
  const bridge = await startBridge({
    preferredPort: 0,
    handler: (incoming) => new Promise((resolve) => {
      observedStart();
      incoming.signal.addEventListener("abort", () => {
        observedAbort();
        resolve({ status: 503 });
      }, { once: true });
    }),
  });

  const pending = fetch(`http://${BRIDGE_HOST}:${bridge.port}/poll`, {
    headers: { authorization: `Bearer ${bridge.token}` },
  }).catch(() => undefined);
  await started;
  await bridge.stop();
  await aborted;
  await pending;
});

test("logs and typed errors never disclose the bearer token", async (context) => {
  const messages: string[] = [];
  const bridge = await startBridge({
    preferredPort: 0,
    tokenFactory: () => "never-log-this-token",
    logger: { info: (message) => messages.push(message), error: (message) => messages.push(message) },
    handler: () => { throw new Error("never-log-this-token"); },
  });
  context.after(() => bridge.stop());

  const response = await request(bridge.port, "/unknown", bridge.token);
  assert.equal(response.status, 500);
  assert.equal(messages.join("\n").includes(bridge.token), false);
  assert.equal(JSON.stringify(response.body).includes(bridge.token), false);
});
