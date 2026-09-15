import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { WorkerHookService, createWorkerHookRoutes } from "../../src/bridge/worker-hooks.js";
import type { AuthenticatedBridgeRequest } from "../../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import { combineHandlers } from "../../src/bridge/router.js";
import { createPlatformLifecycleRoutes } from "../../src/bridge/platform-lifecycle.js";
import { ClaudeAgentPlatform } from "../../src/claude/platform.js";

const at = (value: string) => value as IsoTimestamp;
const timestamp = at("2026-07-30T12:00:00.000Z");
const parentId = "worker-15" as AgentId;

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function temporaryRepository(): { readonly root: string; readonly startingSha: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "aboard-stop-hook-"));
  git(root, "init");
  git(root, "config", "user.name", "Aboard Tests");
  git(root, "config", "user.email", "aboard@example.test");
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return { root, startingSha: git(root, "rev-parse", "HEAD"), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function fleetWithWorker(): FleetRegistry {
  const fleet = new FleetRegistry();
  const worker: AgentSession = {
    platform: "claude",
    identity: { agentId: parentId, type: "implementer" },
    sessionId: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee" as SessionId,
    sessionBinding: "bound",
    terminal: { terminalId: "worker-terminal" as TerminalId, name: "worker" },
    lifecycle: { status: "starting", startedAt: timestamp }, resultDelivery: { mode: "tool-result" },
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 }, issueNumbers: [15],
  };
  fleet.register(worker, timestamp); fleet.transition(parentId, { status: "running", startedAt: timestamp }, timestamp);
  return fleet;
}

function request(path: string, body: unknown): AuthenticatedBridgeRequest {
  return { method: "POST", url: new URL(`http://127.0.0.1${path}`), headers: {}, body, signal: new AbortController().signal };
}

test("rejects removed in-process Agent telemetry routes", async () => {
  const route = createWorkerHookRoutes(new WorkerHookService(fleetWithWorker()));
  assert.equal((await route(request("/hooks/worker/subagent-start", { agentId: parentId }))).status, 404);
  assert.equal((await route(request("/hooks/worker/agent-tool", { agentId: parentId }))).status, 404);
});

test("leaves non-worker POST routes for the next bridge adapter", async () => {
  const route = createWorkerHookRoutes(new WorkerHookService(fleetWithWorker()));
  assert.equal((await route(request("/terminals", {}))).status, 404);
});

test("records compact telemetry and serves each continuation", async () => {
  const task = { path: "C:/Temp/prompts/worker-15/task.md", contents: "Implement the token refresh contract.\n\nRun the browser checks." };
  const fleet = fleetWithWorker(); const service = new WorkerHookService(fleet, { task: async (id) => { assert.equal(id, parentId); return task; } }, () => new Date(timestamp));
  service.compact(parentId, "first summary"); service.compact(parentId, "second summary");
  service.compact(parentId);
  assert.equal(fleet.get(parentId)?.telemetry.compactionCount, 3);
  assert.deepEqual(fleet.get(parentId)?.compactSummaries, ["first summary", "second summary"]);
  const route = createWorkerHookRoutes(service);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await route(request("/hooks/worker/reground", { agentId: parentId }));
    assert.equal(result.status, 200);
  }
  const serialized: unknown = JSON.parse(JSON.stringify(fleet.toPersistenceDto()));
  assert.equal((await import("../../src/domain/validation.js")).parseFleetPersistenceDto(serialized).ok, true);
});

test("re-grounding names every bound issue and refuses a worker bound to none", async () => {
  const bound = (agentId: string, issueNumbers: readonly number[]): AgentSession => ({
    platform: "claude",
    identity: { agentId: agentId as AgentId, type: "implementer" },
    sessionId: "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId,
    sessionBinding: "bound",
    terminal: { terminalId: `${agentId}-terminal` as TerminalId, name: agentId },
    lifecycle: { status: "starting", startedAt: timestamp }, resultDelivery: { mode: "tool-result" },
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
    issueNumbers,
  });
  const many = fleetWithWorker();
  many.register(bound("worker-16", [15, 18]), timestamp);
  const service = new WorkerHookService(many, undefined, () => new Date(timestamp));
  assert.match(await service.reground("worker-16" as AgentId), /issues #15, #18/);

  const unbound = fleetWithWorker();
  unbound.register(bound("worker-17", []), timestamp);
  await assert.rejects(() => new WorkerHookService(unbound, undefined, () => new Date(timestamp)).reground("worker-17" as AgentId));
});

test("worker Python hook is silent for non-aboard and non-Auto-Run sessions", () => {
  const script = join(process.cwd(), "assets", "runtime", "abd_hook.py");
  for (const env of [
    {},
    { ABOARD_AGENT_ID: "interactive-1", ABOARD_AGENT_TYPE: "interactive" },
    { ABOARD_AGENT_ID: "explore-1", ABOARD_AGENT_TYPE: "Explore" },
  ]) {
    const result = spawnSync("uv", ["run", "--no-project", "python", script, "worker-post-compact"], { input: JSON.stringify({ hook_event_name: "PostCompact", compact_summary: "x" }), encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});

test("Python Stop hook reports final output for every Aboard session", async () => {
  const script = join(process.cwd(), "assets", "runtime", "abd_hook.py");
  const stopPayload = JSON.stringify({ hook_event_name: "Stop", cwd: "C:\\repo", last_assistant_message: "Changed the boundary; safely." });
  const received: { url?: string; body?: string }[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      received.push({
        ...(incoming.url !== undefined ? { url: incoming.url } : {}),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");

    const report = async (env: NodeJS.ProcessEnv): Promise<void> => {
      const child = spawn("uv", ["run", "--no-project", "python", script, "worker-stop"], {
        // Force the Windows failure mode on every platform. The hook must use
        // Claude Code's UTF-8 wire format rather than Python's ambient locale.
        env: { ...process.env, ...env, PYTHONIOENCODING: "cp1252", ABOARD_BRIDGE_PORT: String(address.port), ABOARD_BRIDGE_TOKEN: "secret" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.stdin.end(stopPayload);
      const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(status, 0);
      assert.equal(stdout, "");
      assert.equal(stderr, "");
    };

    await report({ ABOARD_AGENT_ID: "interactive-1", ABOARD_AGENT_TYPE: "interactive" });
    await report({ ABOARD_AGENT_ID: "implementer-1", ABOARD_AGENT_TYPE: "implementer" });
    await report({ ABOARD_AGENT_ID: "reviewer-1", ABOARD_AGENT_TYPE: "reviewer" });
    await report({ ABOARD_AGENT_ID: "explore-1", ABOARD_AGENT_TYPE: "Explore" });

    assert.equal(received.length, 4);
    assert.equal(received[0]!.url, "/hooks/stop");
    assert.deepEqual(JSON.parse(received[0]!.body ?? "{}"), {
      agentId: "interactive-1",
      cwd: "C:\\repo",
      lastAssistantMessage: "Changed the boundary; safely.",
    });
    assert.equal(received[1]!.url, "/hooks/stop");
    assert.equal((JSON.parse(received[1]!.body ?? "{}") as { lastAssistantMessage?: unknown }).lastAssistantMessage, "Changed the boundary; safely.");
    assert.equal(received[2]!.url, "/hooks/stop");
    assert.equal((JSON.parse(received[2]!.body ?? "{}") as { lastAssistantMessage?: unknown }).lastAssistantMessage, "Changed the boundary; safely.");
    assert.equal(received[3]!.url, "/hooks/stop");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("Auto Run implementer Stop reminds a dirty worker to commit or report blockers", () => {
  const repository = temporaryRepository();
  try {
    writeFileSync(join(repository.root, "tracked.txt"), "changed\n");
    const script = join(process.cwd(), "assets", "runtime", "abd_hook.py");
    const result = spawnSync("uv", ["run", "--no-project", "python", script, "worker-stop"], {
      cwd: repository.root,
      input: JSON.stringify({ hook_event_name: "Stop", cwd: repository.root, stop_hook_active: false, last_assistant_message: "Done." }),
      encoding: "utf8",
      env: { ...process.env, ABOARD_AGENT_ID: "implementer-1", ABOARD_AGENT_TYPE: "implementer", ABOARD_WORKER_START_SHA: repository.startingSha },
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      decision: "block",
      reason: "You have modified files without committing them. Is there a real reason for this? Did you discover any blockers along the way? If so, immediatly answer \"Yes, there is blockers, as described above\". Otherwise if the task is complete: Commit the changes.",
    });
    assert.equal(result.stderr, "");
  } finally {
    repository.dispose();
  }
});

test("Auto Run reviewer Stop reminds an unchanged worker to create its approval commit", () => {
  const repository = temporaryRepository();
  try {
    const script = join(process.cwd(), "assets", "runtime", "abd_hook.py");
    const result = spawnSync("uv", ["run", "--no-project", "python", script, "worker-stop"], {
      cwd: repository.root,
      input: JSON.stringify({ hook_event_name: "Stop", cwd: repository.root, stop_hook_active: false, last_assistant_message: "The review passed." }),
      encoding: "utf8",
      env: { ...process.env, ABOARD_AGENT_ID: "reviewer-1", ABOARD_AGENT_TYPE: "reviewer", ABOARD_WORKER_START_SHA: repository.startingSha },
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      decision: "block",
      reason: "You have not modified any files or created a review commit. If the review is complete and approved, create an empty commit; otherwise report the blockers and leave the repository unchanged.",
    });
    assert.equal(result.stderr, "");
  } finally {
    repository.dispose();
  }
});

test("non-committing HITL implementer and reviewer turns receive no Stop commit reminder", () => {
  const repository = temporaryRepository();
  try {
    writeFileSync(join(repository.root, "tracked.txt"), "changed\n");
    const script = join(process.cwd(), "assets", "runtime", "abd_hook.py");
    for (const agentType of ["implementer", "reviewer"] as const) {
      const result = spawnSync("uv", ["run", "--no-project", "python", script, "worker-stop"], {
        cwd: repository.root,
        input: JSON.stringify({ hook_event_name: "Stop", cwd: repository.root, stop_hook_active: false, last_assistant_message: "Done." }),
        encoding: "utf8",
        env: { ...process.env, ABOARD_AGENT_ID: `${agentType}-1`, ABOARD_AGENT_TYPE: agentType },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "", agentType);
      assert.equal(result.stderr, "", agentType);
    }
  } finally {
    repository.dispose();
  }
});

test("Auto Run Stop reminders do not repeat or mistake a clean reviewer commit for missing work", () => {
  const repository = temporaryRepository();
  try {
    const script = join(process.cwd(), "assets", "runtime", "abd_hook.py");
    const run = (agentType: "implementer" | "reviewer", stopHookActive: boolean) => spawnSync(
      "uv",
      ["run", "--no-project", "python", script, "worker-stop"],
      {
        cwd: repository.root,
        input: JSON.stringify({ hook_event_name: "Stop", cwd: repository.root, stop_hook_active: stopHookActive, last_assistant_message: "Done." }),
        encoding: "utf8",
        env: { ...process.env, ABOARD_AGENT_ID: `${agentType}-1`, ABOARD_AGENT_TYPE: agentType, ABOARD_WORKER_START_SHA: repository.startingSha },
      },
    );

    writeFileSync(join(repository.root, "tracked.txt"), "changed\n");
    const continuation = run("implementer", true);
    assert.equal(continuation.status, 0);
    assert.equal(continuation.stdout, "");

    git(repository.root, "add", "tracked.txt");
    git(repository.root, "commit", "-m", "review fixes");
    const completedReview = run("reviewer", false);
    assert.equal(completedReview.status, 0);
    assert.equal(completedReview.stdout, "");
  } finally {
    repository.dispose();
  }
});

test("session Python hooks post proof-of-life and reason, and stay silent without boarding env", async () => {
  const script = join(process.cwd(), "assets", "runtime", "abd_hook.py");
  // Guard path: no ABOARD_AGENT_ID means a hand-started session, which must
  // exit 0 with neither stdout nor stderr even for the new routes.
  const silent = spawnSync("uv", ["run", "--no-project", "python", script, "session-start"], { input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }), encoding: "utf8" });
  assert.equal(silent.status, 0); assert.equal(silent.stdout, ""); assert.equal(silent.stderr, "");
  // A SessionEnd payload on the session-start route is dropped before any POST.
  const silentEvent = spawnSync("uv", ["run", "--no-project", "python", script, "session-start"], { input: JSON.stringify({ hook_event_name: "SessionEnd", reason: "clear" }), encoding: "utf8", env: { ...process.env, ABOARD_AGENT_ID: "w1" } });
  assert.equal(silentEvent.status, 0); assert.equal(silentEvent.stdout, ""); assert.equal(silentEvent.stderr, "");

  const received: { url?: string; body?: Record<string, unknown> }[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      received.push({ ...(incoming.url === undefined ? {} : { url: incoming.url }), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    // Session lifecycle applies to every Aboard session, including interactive ones.
    const envFor = { ...process.env, ABOARD_AGENT_ID: "boarded", ABOARD_SESSION_ID: "provisional", ABOARD_AGENT_TYPE: "interactive", ABOARD_BRIDGE_PORT: String(address.port), ABOARD_BRIDGE_TOKEN: "secret" };
    // Async spawn, like the other live-POST hook tests: a synchronous spawn
    // would block the event loop that must answer the hook's request.
    const run = (route: string, payload: object) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("uv", ["run", "--no-project", "python", script, route], { env: envFor, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.stdin.end(JSON.stringify(payload));
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });

    const started = await run("session-start", { hook_event_name: "SessionStart", source: "startup", session_id: "s-1" });
    assert.equal(started.status, 0); assert.equal(started.stdout, ""); assert.equal(started.stderr, "");
    const startPost = received.find((entry) => entry.url === "/hooks/session-start");
    assert.ok(startPost !== undefined);
    assert.deepEqual(startPost.body, { agentId: "boarded", sessionId: "s-1", source: "startup" });

    const ended = await run("session-end", { hook_event_name: "SessionEnd", reason: "clear", session_id: "s-1" });
    assert.equal(ended.status, 0); assert.equal(ended.stdout, ""); assert.equal(ended.stderr, "");
    const endPost = received.find((entry) => entry.url === "/hooks/session-end");
    assert.ok(endPost !== undefined);
    assert.equal(endPost.body?.reason, "clear");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("scaffold registers only lifecycle and Auto Run worker hooks", async () => {
  const hooks = JSON.parse(await readFile(join(process.cwd(), "assets", "runtime", "abd-hooks.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(hooks).sort(), ["PostCompact", "SessionEnd", "SessionStart", "Stop", "StopFailure"].sort());
  assert.equal((hooks.SessionStart as unknown[]).length, 2);
  const regrounding = (hooks.SessionStart as { matcher: string; hooks: { args: string[] }[] }[]).find((entry) => entry.matcher === "compact");
  assert.ok(regrounding?.hooks.some((hook) => hook.args.includes("worker-reground")));
  assert.deepEqual([...scaffoldedRoutes().names].sort(), [
    "session-start",
    "worker-reground",
    "session-end",
    "worker-post-compact",
    "worker-stop",
    "worker-stop-failure",
  ].sort());
});

function scaffoldedRoutes(): { readonly names: readonly string[]; readonly table: Readonly<Record<string, string>> } {
  const script = join(process.cwd(), "assets", "runtime", "abd_hook.py");
  const printed = spawnSync("uv", ["run", "--no-project", "python", script, "--routes"], { encoding: "utf8" });
  assert.equal(printed.status, 0);
  const table = JSON.parse(printed.stdout) as Record<string, string>;
  const registration = readFileSync(join(process.cwd(), "assets", "runtime", "abd-hooks.json"), "utf8");
  const entries = JSON.parse(registration) as Record<string, { hooks: { command: string; args: string[] }[] }[]>;
  const names: string[] = [];
  for (const groups of Object.values(entries)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        // Exec form only: `args` means no shell tokenizes or rewrites anything.
        assert.equal(hook.command, "uv");
        assert.ok(Array.isArray(hook.args));
        const name = hook.args[hook.args.length - 1]!;
        assert.ok(name in table, `unregistered hook route ${name}`);
        names.push(name);
      }
    }
  }
  return { names, table };
}

test("every scaffolded hook route is path-free and served by a bridge route", async () => {
  const { names, table } = scaffoldedRoutes();
  assert.ok(names.length > 0);
  for (const name of names) assert.doesNotMatch(name, /[/\\]/u, "hook route names must not look like paths");
  const registered = new Set(names.map((name) => table[name]!));

  const fleet = new FleetRegistry();
  const workerHooks = new WorkerHookService(fleet);
  const platform = new ClaudeAgentPlatform({
    commandRunner: async () => ({ code: 0, stdout: "2.1.199 (Claude Code)", stderr: "" }),
    lifecycleAssets: {
      settings: join(process.cwd(), "assets", "runtime", "abd-hooks.json"),
      script: join(process.cwd(), "assets", "runtime", "abd_hook.py"),
    },
  });
  const handler = combineHandlers(
    createPlatformLifecycleRoutes({
      fleet,
      platforms: new Map([["claude", platform]]),
      sessions: { sessionStarted: () => false, sessionEnded: () => false },
      workers: { stop: async () => false, failure: async () => false },
      compactions: workerHooks,
    }),
    createWorkerHookRoutes(workerHooks),
  );

  for (const endpoint of registered) {
    const response = await handler({
      method: "POST",
      url: new URL(`http://127.0.0.1${endpoint}`),
      headers: {},
      body: {},
      signal: AbortSignal.abort(),
    });
    // A served route may reject an empty body (400) but must never 404.
    assert.notEqual(response.status, 404, `${endpoint} is registered in the scaffold but no bridge route serves it`);
  }
});
