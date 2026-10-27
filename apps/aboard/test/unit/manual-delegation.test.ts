import assert from "node:assert/strict";
import test from "node:test";
import commandRules from "../../../../harness/productivity/subagents/runtime/src/subagents_runtime/prompt-commands.json";

import { createDelegationRoutes, continueHarnessDelegation, delegationParentSession, providerSession } from "../../src/bridge/manual-delegation.js";

test("Pi loop delegation is refused before starting a process", async () => {
  const handler = createDelegationRoutes({ launch: async () => {
    assert.fail("unsupported Pi loop must not launch");
  } });
  const response = await handler({
    method: "POST", url: new URL("http://localhost/delegations"), headers: {}, signal: new AbortController().signal,
    body: { requestId: "pi-loop", provider: "pi", mode: "loop", prompt: "Implement the task.", cwd: process.cwd() },
  });
  assert.equal(response.status, 400);
});

test("manual delegation preserves skills and neutralizes built-in commands with explicit or default models", async () => {
  const launches: unknown[] = [];
  const handler = createDelegationRoutes({ launch: async (request) => {
    launches.push(request);
    return { agentId: "agent", sessionId: "child", terminalId: "terminal" };
  } });
  for (const provider of ["claude", "chatgpt", "pi"] as const) {
    const selector = `${provider === "claude" ? "/" : provider === "pi" ? "/skill:" : "$"}prototype`;
    const commands = commandRules.commands[provider];
    const preserved = [selector, "/resume/file", "é/resume", "Ⅻ/resume", "$HOME", "/plugin:custom-audit", "/unknown-skill"];
    const prompt = [...preserved, ...commands.map((name) => `/${name}`)].join("\n");
    for (const model of [undefined, provider === "claude" ? "claude-opus-5-5" : provider === "pi" ? "openai/gpt-6.1-sol" : "gpt-6.1-sol"]) {
      const response = await handler({
        method: "POST", url: new URL("http://localhost/delegations"), headers: {}, signal: new AbortController().signal,
        body: { requestId: `${provider}-${model}`, provider, mode: "interactive", prompt, cwd: "C:\\work",
          ...(model === undefined ? {} : { model }) },
      });
      assert.equal(response.status, 201);
      const received = launches.at(-1) as Record<string, unknown>;
      assert.equal(received.model, model);
      assert.equal(Object.hasOwn(received, "model"), model !== undefined);
      const forwarded = received.prompt as string;
      assert.deepEqual(forwarded.match(/[/\$][\p{L}\p{N}_:/-]+/gu), preserved.map((token) => token.slice(token.search(/[/\$]/u))));
    }
  }
});

test("manual delegation accepts every effort level and rejects invalid levels", async () => {
  const received: Record<string, unknown>[] = [];
  const handler = createDelegationRoutes({ launch: async (request) => {
    received.push(request as unknown as Record<string, unknown>);
    return { agentId: "agent", sessionId: "child", terminalId: "terminal" };
  } });
  for (const effort of [undefined, "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "invalid", 2, null]) {
    const response = await handler({
      method: "POST", url: new URL("http://localhost/delegations"), headers: {}, signal: new AbortController().signal,
      body: { requestId: `effort-${effort}`, provider: "chatgpt", mode: "interactive", prompt: "Work.", cwd: "C:\\work",
        ...(effort === undefined ? {} : { effort }) },
    });
    if (effort === "invalid" || effort === 2 || effort === null) assert.equal(response.status, 400);
    else {
      assert.equal(response.status, 201);
      assert.equal(received.at(-1)?.effort, effort);
      assert.equal(Object.hasOwn(received.at(-1)!, "effort"), effort !== undefined);
    }
  }
});

test("loop delegation retains runtime ownership and difficulty without a worker skill", async () => {
  const launches: unknown[] = [];
  const handler = createDelegationRoutes({ launch: async (request) => {
    launches.push(request);
    return { agentId: "implementer", sessionId: "child", terminalId: "visible" };
  } });
  const response = await handler({
    method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {},
    signal: new AbortController().signal,
    body: { requestId: "loop-1", mode: "loop", provider: "chatgpt", cwd: "C:\\feature",
      prompt: "Read the implementer file.", difficulty: "routine", harnessSessionId: "child", parentSessionId: "lead", executionId: "execution" },
  });
  assert.equal(response.status, 201);
  const received = launches[0] as Record<string, unknown>;
  assert.equal(received.task, "loop");
  assert.equal(received.type, "general");
  assert.equal(received.executionMode, "loop");
  assert.equal(received.harnessSessionId, "child");
  assert.equal(received.parentSessionId, "lead");
  assert.equal(received.executionId, "execution");
  assert.equal(received.difficulty, "routine");
  assert.equal(received.skill, undefined);
});

test("scoped delegations admit registered sibling checkouts and their subdirectories in every supported mode",  async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "aboard-loop-"));
  const project = join(root, "project"), worktree = join(root, "feature"), other = join(root, "other");
  try {
    await mkdir(other);
    const git = promisify(execFile);
    await git("git", ["init", project]);
    await git("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
    await git("git", ["-C", project, "worktree", "add", "-b", "feature", worktree]);
    const subdirectory = join(worktree, "src");
    await mkdir(subdirectory);
    const launched: string[] = [];
    const handler = createDelegationRoutes({ launch: async (request) => {
      launched.push(request.cwd); return { agentId: "implementer", sessionId: "child", terminalId: "visible" };
    } }, { workspaceRoot: project });
    for (const [cwd, mode, status] of [[worktree, "loop", 201], [other, "loop", 403], [worktree, "interactive", 201], [subdirectory, "interactive", 201], [worktree, "auto", 201], [other, "interactive", 403], [other, "auto", 403]] as const) {
      const response = await handler({ method: "POST", url: new URL("http://localhost/delegations"), headers: {}, authorizationScope: "delegation",
        signal: new AbortController().signal,
        body: { requestId: `${cwd}-${mode}`, provider: "claude", mode, prompt: "Read the task file.", cwd },
      });
      assert.equal(response.status, status);
    }
    assert.deepEqual(launched, [worktree, worktree, subdirectory, worktree]);
    // A stale worktree registration does not authorize a replacement repository.
    await rm(join(worktree, ".git"));
    await git("git", ["init", worktree]);
    for (const mode of ["interactive", "auto", "loop"] as const) {
      const response = await handler({ method: "POST", url: new URL("http://localhost/delegations"), headers: {}, authorizationScope: "delegation",
        signal: new AbortController().signal,
        body: { requestId: `replacement-${mode}`, provider: "claude", mode, prompt: "Inspect files.", cwd: subdirectory },
      });
      assert.equal(response.status, 403);
    }
    assert.equal(launched.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual delegation maps an explicit skill to general delegation with the requested mode", async () => {
  const launches: unknown[] = [];
  const handler = createDelegationRoutes({
    launch: async (request) => { launches.push(request); return { agentId: "agent-4", sessionId: "session", terminalId: "terminal" }; },
  });

  const response = await handler({
    method: "POST",
    url: new URL("http://127.0.0.1/delegations"),
    headers: {},
    body: { requestId: "request-1", skill: "websearch", provider: "chatgpt", mode: "auto", prompt: "Find primary sources.", cwd: "C:\\work" },
    signal: new AbortController().signal,
  });

  assert.equal(response.status, 201);
  const { prompt: _prompt, ...received } = launches[0] as Record<string, unknown>;
  assert.deepEqual(received, {
    requestId: "request-1", type: "general", task: "general", provider: "chatgpt", executionMode: "auto",
    skill: "websearch", cwd: "C:\\work", description: "general",
  });
});

test("manual delegation accepts explicit skills in either execution mode", async () => {
  const launches: Record<string, unknown>[] = [];
  const handler = createDelegationRoutes({
    launch: async (request) => { launches.push(request as unknown as Record<string, unknown>); return { agentId: "agent-4", sessionId: "session", terminalId: "terminal" }; },
  });
  for (const mode of ["auto", "interactive"] as const) {
    for (const skill of [undefined, "prototype", "custom-audit"]) {
      const response = await handler({
        method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {},
        body: { requestId: `${mode}-${skill}`, provider: "chatgpt", mode, prompt: "Do it.", cwd: "C:\\work", ...(skill === undefined ? {} : { skill }) },
        signal: new AbortController().signal,
      });
      assert.equal(response.status, 201);
      assert.equal(launches.at(-1)?.skill, skill);
      assert.equal(launches.at(-1)?.task, "general");
      assert.equal(launches.at(-1)?.executionMode, mode);
    }
  }
});

test("manual delegation rejects removed task fields and unknown fields", async () => {
  const handler = createDelegationRoutes({ launch: async () => { throw new Error("must not launch"); } });
  for (const body of [
    { requestId: "prototype-auto", task: "prototype", provider: "claude", mode: "auto", prompt: "x", cwd: "C:\\work" },
    { requestId: "request-1", task: "explore", provider: "claude", mode: "interactive", prompt: "x", cwd: "C:\\work" },
    { requestId: "request-2", provider: "claude", mode: "auto", prompt: "x", cwd: "C:\\work", token: "leak" },
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
    body: { requestId: "request-1", provider: "claude", mode: "auto", prompt: "Do it.", cwd: "C:\\work" },
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
    body: { requestId: "request-1", provider: "claude", mode: "auto", prompt: "Do it.", cwd: "C:\\other" },
    signal: new AbortController().signal,
  });

  assert.equal(response.status, 403);
});


test("resume preserves skills and neutralizes built-in commands", async () => {
  let resumed = false;
  const handler = createDelegationRoutes({
    launch: async () => { throw new Error("must continue the existing child"); },
    resume: async (request) => {
      resumed = true;
      assert.deepEqual(request.prompt.match(/[/\$][\w-]+/gu), ["$address-this"]);
      return { agentId: "child", sessionId: "saved", terminalId: "process-2" };
    },
  });
  for (const provider of ["claude", "chatgpt", "pi"]) {
    resumed = false;
    const response = await handler({ method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {}, body: { requestId: `resume-${provider}`, provider, mode: "auto", prompt: "$address-this next task\n/resume /compact", cwd: "C:\\work", resumeAgentId: "child", resumeSessionId: "saved" }, signal: new AbortController().signal });
    assert.equal(response.status, 201);
    assert.equal(resumed, true);
  }
});

test("delegation deduplication survives bridge restart and rejects conflicting reuse", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "harness-delegation-"));
  let launches = 0;
  const launcher = { launch: async () => { launches += 1; return { agentId: "agent-1", sessionId: "saved", terminalId: "process-1" }; } };
  const request = { method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {}, body: { requestId: "persistent", provider: "claude", mode: "auto", prompt: "/resume", cwd: root }, signal: new AbortController().signal };
  try {
    assert.equal((await createDelegationRoutes(launcher, { stateDirectory: root })(request)).status, 201);
    const restarted = createDelegationRoutes(launcher, { stateDirectory: root });
    assert.equal((await restarted(request)).status, 201);
    assert.equal(launches, 1);
    assert.equal((await restarted({ ...request, body: { ...request.body, prompt: "resume" } })).status, 409);
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
  const request = { method: "POST", url: new URL("http://127.0.0.1/delegations"), headers: {}, body: { requestId: "unfinished", provider: "claude", mode: "auto", prompt: "Task", cwd: root }, signal: new AbortController().signal };
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
  const body = { requestId: "initial", provider: "claude", mode: "interactive", prompt: "Task", cwd: root,
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
      assert.equal(binding.task, "general");
      assert.equal(message, "Next task");
      const restarted = createDelegationRoutes({ launch: async () => assert.fail("must resume"), resume: async () => ({ agentId: "agent-1", sessionId: "native", terminalId: "terminal-2" }) }, { stateDirectory: root });
      assert.equal((await restarted({ ...request, body: { ...body, requestId: "next", resumeAgentId: "agent-1", resumeSessionId: "native" } })).status, 201);
    });
    assert.deepEqual(resumed, { agentId: "agent-1", sessionId: "native", terminalId: "terminal-2" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a delegated child resolves the saved parent session for an explicit terminal link", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "harness-focus-parent-"));
  const handler = createDelegationRoutes(
    { launch: async () => ({ agentId: "agent-2", sessionId: "native-child", terminalId: "terminal-2" }) },
    { stateDirectory: root },
  );
  const signal = new AbortController().signal;
  try {
    const launched = await handler({
      authorizationScope: "delegation",
      method: "POST",
      url: new URL("http://127.0.0.1/delegations"),
      headers: {},
      body: { requestId: "request-1", provider: "claude", mode: "interactive", prompt: "Task", cwd: root, harnessSessionId: "stable-child", parentSessionId: "native-parent" },
      signal,
    });
    assert.equal(launched.status, 201);

    assert.equal(await delegationParentSession(root, "stable-child"), "native-parent");
    assert.equal(await delegationParentSession(root, "missing-child"), undefined);
    // A grandchild's parent is this delegated child, running under its own provider session.
    assert.equal(await providerSession(root, "stable-child"), "native-child");
    assert.equal(await providerSession(root, "native-parent"), "native-parent");
  } finally { await rm(root, { recursive: true, force: true }); }
});
