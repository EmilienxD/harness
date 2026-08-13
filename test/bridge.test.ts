import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import type {
  BridgeDiscoveryMetadata,
  BridgeDiscoveryPersistence,
} from "../src/bridge/discovery.js";
import { BRIDGE_HOST, startBridge } from "../src/bridge/server.js";

class MemoryPersistence implements BridgeDiscoveryPersistence {
  public metadata: BridgeDiscoveryMetadata | undefined;
  public cleared = false;

  public async write(metadata: BridgeDiscoveryMetadata): Promise<void> {
    this.metadata = metadata;
  }

  public async clear(): Promise<void> {
    this.cleared = true;
    this.metadata = undefined;
  }
}

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
  const persistence = new MemoryPersistence();
  const bridge = await startBridge({
    preferredPort: 0,
    persistence,
    tokenFactory: () => "activation-token",
    handler: (incoming) => ({ status: 200, body: { path: incoming.url.pathname } }),
  });
  context.after(() => bridge.stop());

  assert.equal(bridge.host, "127.0.0.1");
  assert.equal(persistence.metadata?.host, "127.0.0.1");
  assert.equal((await request(bridge.port, "/hook")).status, 401);
  assert.equal((await request(bridge.port, "/cli/agent", "wrong-token")).status, 401);
  assert.deepEqual(await request(bridge.port, "/cli/agent", bridge.token), {
    status: 200,
    body: { path: "/cli/agent" },
  });
});

test("rotates tokens between activations", async () => {
  const first = await startBridge({
    preferredPort: 0,
    persistence: new MemoryPersistence(),
    handler: () => ({ status: 204 }),
  });
  const second = await startBridge({
    preferredPort: 0,
    persistence: new MemoryPersistence(),
    handler: () => ({ status: 204 }),
  });
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(first.token, uuidV4);
  assert.match(second.token, uuidV4);
  assert.notEqual(first.token, second.token);
  await Promise.all([first.stop(), second.stop()]);
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
    persistence: new MemoryPersistence(),
    handler: () => ({ status: 204 }),
  });
  context.after(() => bridge.stop());
  assert.notEqual(bridge.port, address.port);
});

test("rejects malformed JSON without invoking the handler", async (context) => {
  let calls = 0;
  const bridge = await startBridge({
    preferredPort: 0,
    persistence: new MemoryPersistence(),
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

test("shutdown aborts pending long polls and clears discovery metadata", async () => {
  const persistence = new MemoryPersistence();
  let observedStart!: () => void;
  const started = new Promise<void>((resolve) => { observedStart = resolve; });
  let observedAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
  const bridge = await startBridge({
    preferredPort: 0,
    persistence,
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
  assert.equal(persistence.cleared, true);
});

test("logs and typed errors never disclose the bearer token", async (context) => {
  const messages: string[] = [];
  const bridge = await startBridge({
    preferredPort: 0,
    persistence: new MemoryPersistence(),
    tokenFactory: () => "never-log-this-token",
    logger: { info: (message) => messages.push(message), error: (message) => messages.push(message) },
    handler: () => { throw new Error("never-log-this-token"); },
  });
  context.after(() => bridge.stop());

  const response = await request(bridge.port, "/cli/agent", bridge.token);
  assert.equal(response.status, 500);
  assert.equal(messages.join("\n").includes(bridge.token), false);
  assert.equal(JSON.stringify(response.body).includes(bridge.token), false);
});
