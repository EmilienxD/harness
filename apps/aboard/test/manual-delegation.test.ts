import assert from "node:assert/strict";
import test from "node:test";

import { createDelegationRoutes } from "../src/bridge/manual-delegation.js";

test("manual delegation maps task identity and explicit execution mode", async () => {
  const launches: unknown[] = [];
  const handler = createDelegationRoutes({
    launch: async (request) => { launches.push(request); return { agentId: "agent-4", sessionId: "session", terminalId: "terminal" }; },
  });

  const response = await handler({
    method: "POST",
    url: new URL("http://127.0.0.1/delegations"),
    headers: {},
    body: { requestId: "request-1", task: "websearch", provider: "chatgpt", mode: "auto", prompt: "Find primary sources.", cwd: "C:\\work" },
    signal: new AbortController().signal,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(launches, [{
    requestId: "request-1", type: "Web Search", provider: "chatgpt", executionMode: "auto",
    prompt: "$websearch\n\nFind primary sources.", cwd: "C:\\work", description: "Web Search",
  }]);
});

test("manual issue delegation invokes the reader worker skills", async () => {
  const launches: unknown[] = [];
  const handler = createDelegationRoutes({
    launch: async (request) => { launches.push(request); return { agentId: "agent-4", sessionId: "session", terminalId: "terminal" }; },
  });

  for (const [index, task] of ["implement", "review"].entries()) {
    const response = await handler({
      method: "POST",
      url: new URL("http://127.0.0.1/delegations"),
      headers: {},
      body: { requestId: `request-${index}`, task, provider: "chatgpt", mode: "auto", prompt: "Do it.", cwd: "C:\\work" },
      signal: new AbortController().signal,
    });
    assert.equal(response.status, 201);
  }

  assert.deepEqual(launches, [
    {
      requestId: "request-0", type: "General", provider: "chatgpt", executionMode: "auto",
      prompt: "$address-issue\n\nDo it.", cwd: "C:\\work", description: "Issue Implementation",
    },
    {
      requestId: "request-1", type: "General", provider: "chatgpt", executionMode: "auto",
      prompt: "$review-issue\n\nDo it.", cwd: "C:\\work", description: "Issue Review",
    },
  ]);
});

test("manual delegation rejects unknown fields and task-mode combinations", async () => {
  const handler = createDelegationRoutes({ launch: async () => { throw new Error("must not launch"); } });
  for (const body of [
    { requestId: "request-1", task: "explore", provider: "claude", mode: "interactive", prompt: "x", cwd: "C:\\work" },
    { requestId: "request-2", task: "general", provider: "claude", mode: "auto", prompt: "x", cwd: "C:\\work", token: "leak" },
    { requestId: "request-3", task: "general", provider: "claude", mode: "auto", prompt: "/prototype substitute", cwd: "C:\\work" },
  ]) {
    const response = await handler({ method: "POST", url: new URL("http://x/delegations"), headers: {}, body, signal: new AbortController().signal });
    assert.equal(response.status, 400);
  }
});

test("manual delegation replays an idempotent request without launching twice", async () => {
  let launches = 0;
  const handler = createDelegationRoutes({
    launch: async () => {
      launches += 1;
      return { agentId: "agent-4", sessionId: "session", terminalId: "terminal" };
    },
  });
  const request = {
    method: "POST",
    url: new URL("http://127.0.0.1/delegations"),
    headers: {},
    body: { requestId: "request-1", task: "general", provider: "claude", mode: "auto", prompt: "Do it.", cwd: "C:\\work" },
    signal: new AbortController().signal,
  };

  const [first, replay] = await Promise.all([handler(request), handler(request)]);

  assert.equal(launches, 1);
  assert.deepEqual(replay, first);
});

test("the published delegation credential cannot escape its workspace", async () => {
  const handler = createDelegationRoutes(
    { launch: async () => { throw new Error("must not launch"); } },
    { workspaceRoot: "C:\\work" },
  );

  const response = await handler({
    authorizationScope: "delegation",
    method: "POST",
    url: new URL("http://127.0.0.1/delegations"),
    headers: {},
    body: { requestId: "request-1", task: "general", provider: "claude", mode: "auto", prompt: "Do it.", cwd: "C:\\other" },
    signal: new AbortController().signal,
  });

  assert.equal(response.status, 403);
});
