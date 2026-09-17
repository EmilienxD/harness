import assert from "node:assert/strict";
import test from "node:test";

import { createDelegationRoutes, continueHarnessDelegation } from "../../src/bridge/manual-delegation.js";

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
    requestId: "request-1", type: "websearch", provider: "chatgpt", executionMode: "auto",
    prompt: "Find primary sources.", skill: "websearch", cwd: "C:\\work", description: "websearch",
  }]);
});

test("manual issue delegation invokes the reader worker skills", async () => {
  const launches: unknown[] = [];
  const handler = createDelegationRoutes({
    launch: async (request) => { launches.push(request); return { agentId: "agent-4", sessionId: "session", terminalId: "terminal" }; },
  });

  for (const [index, task] of ["address", "review"].entries()) {
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
      requestId: "request-0", type: "general", provider: "chatgpt", executionMode: "auto",
      prompt: "Do it.", skill: "address-this", cwd: "C:\\work", description: "Address",
    },
    {
      requestId: "request-1", type: "general", provider: "chatgpt", executionMode: "auto",
      prompt: "Do it.", skill: "review-this", cwd: "C:\\work", description: "Review",
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


test("resume delivers the next message without launch skill restrictions", async () => {
  let resumed = false;
  const handler = createDelegationRoutes({
    launch: async () => { throw new Error("must continue the existing child"); },
    resume: async (request) => {
      resumed = true;
      assert.equal(request.prompt, "$address-this next task");
      return { agentId: "child", sessionId: "saved", terminalId: "process-2" };
    },
  });
  const response = await handler({ method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {}, body: { requestId: "resume-1", task: "general", provider: "claude", mode: "auto", prompt: "$address-this next task", cwd: "C:\\work", resumeAgentId: "child", resumeSessionId: "saved" }, signal: new AbortController().signal });
  assert.equal(response.status, 201);
  assert.equal(resumed, true);
});

test("delegation deduplication survives bridge restart and rejects conflicting reuse", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "harness-delegation-"));
  let launches = 0;
  const launcher = { launch: async () => { launches += 1; return { agentId: "agent-1", sessionId: "saved", terminalId: "process-1" }; } };
  const request = { method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {}, body: { requestId: "persistent", task: "general", provider: "claude", mode: "auto", prompt: "Task", cwd: root }, signal: new AbortController().signal };
  try {
    assert.equal((await createDelegationRoutes(launcher, { stateDirectory: root })(request)).status, 201);
    const restarted = createDelegationRoutes(launcher, { stateDirectory: root });
    assert.equal((await restarted(request)).status, 201);
    assert.equal(launches, 1);
    assert.equal((await restarted({ ...request, body: { ...request.body, prompt: "Different" } })).status, 409);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unfinished delegation claim is refused as uncertain, not as an ordinary conflict", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "harness-uncertain-"));
  const launcher = { launch: async () => { throw new Error("the terminal could not be created"); } };
  const request = { method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {}, body: { requestId: "unfinished", task: "general", provider: "claude", mode: "auto", prompt: "Task", cwd: root }, signal: new AbortController().signal };
  const codeOf = (response: { readonly body?: unknown }): string => (response.body as { readonly error: { readonly code: string } }).error.code;
  try {
    const refused = await createDelegationRoutes(launcher, { stateDirectory: root })(request);
    assert.equal(refused.status, 409);
    assert.equal(codeOf(refused), "conflict");

    const retried = await createDelegationRoutes(launcher, { stateDirectory: root })(request);

    assert.equal(retried.status, 409);
    assert.equal(codeOf(retried), "startup-uncertain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caller-driven reopen continues through the child's saved Harness state after a bridge restart", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "harness-reopen-"));
  const body = { requestId: "initial", task: "general", provider: "claude", mode: "interactive", prompt: "Task", cwd: root,
    harnessSessionId: "stable-child", parentSessionId: "parent", harnessStateDirectory: join(root, "state"), harnessRuntimePath: join(root, "runtime") };
  const request = { method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {}, body, signal: new AbortController().signal };
  try {
    const handler = createDelegationRoutes({ launch: async () => ({ agentId: "agent-1", sessionId: "native", terminalId: "terminal-1" }) }, { stateDirectory: root });
    assert.equal((await handler(request)).status, 201);
    const resumed = await continueHarnessDelegation(root, { agentId: "agent-1", sessionId: "native", platform: "claude", prompt: "Next task" }, async (binding, message) => {
      assert.equal(binding.harnessSessionId, "stable-child");
      assert.equal(binding.parentSessionId, "parent");
      assert.equal(binding.harnessStateDirectory, join(root, "state"));
      assert.equal(binding.executionMode, "interactive");
      assert.equal(message, "Next task");
      const restarted = createDelegationRoutes({ launch: async () => assert.fail("must resume"), resume: async () => ({ agentId: "agent-1", sessionId: "native", terminalId: "terminal-2" }) }, { stateDirectory: root });
      assert.equal((await restarted({ ...request, body: { ...body, requestId: "next", resumeAgentId: "agent-1", resumeSessionId: "native" } })).status, 201);
    });
    assert.deepEqual(resumed, { agentId: "agent-1", sessionId: "native", terminalId: "terminal-2" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a completed child delegation focuses its saved parent session", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "harness-focus-parent-"));
  const focused: string[] = [];
  const handler = createDelegationRoutes(
    { launch: async () => ({ agentId: "agent-2", sessionId: "native-child", terminalId: "terminal-2" }) },
    { stateDirectory: root, focusParent: (sessionId) => { focused.push(sessionId); return true; } },
  );
  const signal = new AbortController().signal;
  try {
    const launched = await handler({
      authorizationScope: "delegation",
      method: "POST",
      url: new URL("http://127.0.0.1/delegations"),
      headers: {},
      body: { requestId: "request-1", task: "general", provider: "claude", mode: "interactive", prompt: "Task", cwd: root, harnessSessionId: "stable-child", parentSessionId: "native-parent" },
      signal,
    });
    assert.equal(launched.status, 201);

    const response = await handler({
      authorizationScope: "full",
      method: "POST",
      url: new URL("http://127.0.0.1/delegations/focus-parent"),
      headers: {},
      body: { childSessionId: "stable-child" },
      signal,
    });

    assert.equal(response.status, 204);
    assert.deepEqual(focused, ["native-parent"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
