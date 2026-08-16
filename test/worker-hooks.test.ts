import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { WorkerHookService, createWorkerHookRoutes } from "../src/bridge/worker-hooks.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";
import { combineHandlers } from "../src/bridge/router.js";
import { ManagerBriefings, ManagerPromptService, ManagerStopService, RoadmapReminderService, createManagerHookRoutes } from "../src/bridge/manager-hooks.js";
import { createWorkerLifecycleRoutes } from "../src/bridge/lifecycle.js";
import { SessionLifecycleService, SessionProcessMonitor, createSessionLifecycleRoutes } from "../src/bridge/session-lifecycle.js";

const at = (value: string) => value as IsoTimestamp;
const timestamp = at("2026-07-30T12:00:00.000Z");
const parentId = "worker-15" as AgentId;

function fleetWithWorker(): FleetRegistry {
  const fleet = new FleetRegistry();
  const worker: AgentSession = {
    identity: { agentId: parentId, type: "implementer" },
    sessionId: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee" as SessionId,
    terminal: { terminalId: "worker-terminal" as TerminalId, name: "worker" },
    lifecycle: { status: "starting", startedAt: timestamp }, resultDelivery: { mode: "tool-result" },
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 }, issueNumber: 15,
  };
  fleet.register(worker, timestamp); fleet.transition(parentId, { status: "running", startedAt: timestamp }, timestamp);
  return fleet;
}

function request(path: string, body: unknown): AuthenticatedBridgeRequest {
  return { method: "POST", url: new URL(`http://127.0.0.1${path}`), headers: {}, body, signal: new AbortController().signal };
}

test("tracks child lifecycle and merges optional Agent telemetry", async () => {
  const fleet = fleetWithWorker(); const service = new WorkerHookService(fleet, { current: async () => "issue-15" }, () => new Date(timestamp));
  const route = createWorkerHookRoutes(service);
  assert.equal((await route(request("/hooks/worker/subagent-start", { parentAgentId: parentId, childAgentId: "explore-1", agentType: "Explore" }))).status, 200);
  assert.equal(fleet.listChildren(parentId)[0]?.status, "running");
  assert.equal((await route(request("/hooks/worker/agent-tool", { parentAgentId: parentId, toolResponse: { agentId: "explore-1", content: [{ type: "text", text: "found it" }], totalTokens: 42, usage: { input_tokens: 30, output_tokens: 12 }, resolvedModel: "claude-sonnet" } }))).status, 200);
  assert.deepEqual(fleet.listChildren(parentId)[0]?.telemetry, { totalTokens: 42, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0, resolvedModel: "claude-sonnet", usage: { inputTokens: 30, outputTokens: 12 } });
  assert.equal((await route(request("/hooks/worker/subagent-stop", { parentAgentId: parentId, childAgentId: "explore-1", result: "complete" }))).status, 200);
  assert.equal(fleet.listChildren(parentId)[0]?.status, "completed");
  assert.equal(fleet.listChildren(parentId)[0]?.result, "complete");
});

test("leaves non-worker POST routes for the next bridge adapter", async () => {
  const route = createWorkerHookRoutes(new WorkerHookService(fleetWithWorker()));
  assert.equal((await route(request("/terminals", {}))).status, 404);
});

test("records compact summaries, repeat count, and precise re-grounding", async () => {
  const fleet = fleetWithWorker(); const service = new WorkerHookService(fleet, { current: async (cwd) => { assert.equal(cwd, "C:\\repo"); return "feat/issue-15"; } }, () => new Date(timestamp));
  service.compact(parentId, "first summary"); service.compact(parentId, "second summary");
  assert.equal(fleet.get(parentId)?.telemetry.compactionCount, 2);
  assert.deepEqual(fleet.get(parentId)?.compactSummaries, ["first summary", "second summary"]);
  assert.equal(await service.reground(parentId, "C:\\repo"), "You are aboard worker worker-15, implementing issue #15 on branch feat/issue-15. Continue from the resolved issue and spec supplied in your first message. If that contract is no longer available after compaction, stop and report that plainly; do not fetch it with gh.");
  const serialized: unknown = JSON.parse(JSON.stringify(fleet.toPersistenceDto()));
  assert.equal((await import("../src/domain/validation.js")).parseFleetPersistenceDto(serialized).ok, true);
});

test("worker Python hook is silent for non-aboard and wrong-role sessions", () => {
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  for (const env of [
    {},
    { ABOARD_AGENT_ID: "manager", ABOARD_AGENT_TYPE: "manager" },
    { ABOARD_AGENT_ID: "research-1", ABOARD_AGENT_TYPE: "webresearcher" },
    // Explore is automated-only and read-only: like webresearcher it has no
    // implementation contract to re-ground and spawns no subagents, so every
    // route but its stop and the lifecycle pair is guarded off.
    { ABOARD_AGENT_ID: "explore-1", ABOARD_AGENT_TYPE: "Explore" },
  ]) {
    const result = spawnSync("uv", ["run", "--no-project", "python", script, "worker-post-compact"], { input: JSON.stringify({ hook_event_name: "PostCompact", compact_summary: "x" }), encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});

test("worker Python hook guards general-purpose on ABOARD_DELIVERS_RESULT and treats Explore as automated worker", async () => {
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  const stopPayload = JSON.stringify({ hook_event_name: "Stop", cwd: "C:\\repo", last_assistant_message: "done" });
  // An interactive general-purpose session reports nothing: without the delivery flag
  // the guard exits 0 with no output, exactly like a brainstormer.
  const silent = spawnSync("uv", ["run", "--no-project", "python", script, "worker-stop"], { input: stopPayload, encoding: "utf8", env: { ...process.env, ABOARD_AGENT_ID: "gp-1", ABOARD_AGENT_TYPE: "general-purpose" } });
  assert.equal(silent.status, 0); assert.equal(silent.stdout, ""); assert.equal(silent.stderr, "");

  // general-purpose launched to deliver a result reports its stop: the flag opens the worker route.
  // Explore is automated-only and in WORKER_AGENT_TYPES, so it reports its stop directly.
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

    // Spawned asynchronously — a synchronous spawn would block the event loop
    // that has to answer the hook's POST. A reporting hook stays silent on both
    // streams: its output is the bridge call, never terminal text.
    const report = async (env: NodeJS.ProcessEnv): Promise<void> => {
      const child = spawn("uv", ["run", "--no-project", "python", script, "worker-stop"], {
        env: { ...process.env, ...env, ABOARD_BRIDGE_PORT: String(address.port), ABOARD_BRIDGE_TOKEN: "secret" },
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

    // The flag, not the type, opens the worker route for general-purpose.
    await report({ ABOARD_AGENT_ID: "gp-1", ABOARD_AGENT_TYPE: "general-purpose", ABOARD_DELIVERS_RESULT: "1" });
    // Explore is automated-only, so its type alone opens the route.
    await report({ ABOARD_AGENT_ID: "explore-1", ABOARD_AGENT_TYPE: "Explore" });

    assert.equal(received.length, 2);
    assert.equal(received[0]!.url, "/hooks/stop");
    assert.match(received[0]!.body ?? "", /gp-1/);
    assert.equal(received[1]!.url, "/hooks/stop");
    assert.match(received[1]!.body ?? "", /explore-1/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("session Python hooks post proof-of-life and reason, and stay silent without boarding env", async () => {
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
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
    // A Manager-type env with no delivery flag: the session-lifecycle routes
    // must fire for every aboard session, not only result-delivering workers.
    const envFor = { ...process.env, ABOARD_AGENT_ID: "boarded", ABOARD_AGENT_TYPE: "manager", ABOARD_BRIDGE_PORT: String(address.port), ABOARD_BRIDGE_TOKEN: "secret" };
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

test("scaffold registers lifecycle, Agent telemetry, and compact re-grounding", async () => {

  const hooks = JSON.parse(await readFile(join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard-hooks.json"), "utf8")) as Record<string, unknown>;
  for (const event of ["SubagentStart", "SubagentStop", "PostToolUse", "PostCompact", "Stop", "StopFailure"]) assert.ok(event in hooks);
  assert.equal((hooks.PostToolUse as { matcher: string }[])[0]?.matcher, "Agent");
  // SessionStart carries the proof-of-life registration plus the manager
  // briefings and the compact re-grounding entry.
  assert.equal((hooks.SessionStart as unknown[]).length, 3);
  assert.ok("SessionEnd" in hooks);
  // InstructionsLoaded has no decision control, so additionalContext returned
  // from it is discarded. Re-grounding must ride SessionStart(compact) alone.
  assert.ok(!("InstructionsLoaded" in hooks));
  const regrounding = (hooks.SessionStart as { matcher: string; hooks: { args: string[] }[] }[]).find((entry) => entry.matcher === "compact");
  assert.ok(regrounding?.hooks.some((hook) => hook.args.includes("worker-reground")));
});

/**
 * Registered hooks address the script by opaque route name, never by URL path,
 * so Git Bash on Windows cannot rewrite the argument into a filesystem path.
 * The script owns the name-to-endpoint table and exposes it with `--routes`;
 * reading it back keeps this test on the same source of truth.
 */
function scaffoldedRoutes(): { readonly names: readonly string[]; readonly table: Readonly<Record<string, string>> } {
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  const printed = spawnSync("uv", ["run", "--no-project", "python", script, "--routes"], { encoding: "utf8" });
  assert.equal(printed.status, 0);
  const table = JSON.parse(printed.stdout) as Record<string, string>;
  const registration = readFileSync(join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard-hooks.json"), "utf8");
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

  // The composed handler chain from the extension composition root. A route the
  // scaffold POSTs to but nothing serves is a 404 at runtime, which is exactly
  // how the Manager briefings and worker results were silently lost before.
  const fleet = new FleetRegistry();
  const lease = new WriteLease();
  const briefings = new ManagerBriefings(
    {
      repository: async () => ({ name: "aboard", defaultBranch: "main", checks: [] }),
      git: async () => ({ branch: "main", head: "abc1234", dirty: false }),
      github: async () => ({ issues: [], openPullRequests: [], unreviewedMergeCount: 0 }),
      roadmap: async () => ({ number: 12, tasks: [{ position: 1, subject: "Ship the bridge", completed: false }], carrierCount: 1, nearBound: false, duplicateSubjects: [] }),
      autoRun: () => undefined,
    },
    fleet, lease,
  );
  const handler = combineHandlers(
    createManagerHookRoutes(
      briefings,
      new ManagerStopService({ fleet }),
      new ManagerPromptService(fleet, { spawnInteractive: async () => ({ agentId: "a" }) }),
      new RoadmapReminderService({ roadmap: async () => undefined }),
    ),
    createWorkerLifecycleRoutes({ stop: async () => true, stopFailure: async () => true, timeout: async () => true, terminalClosed: async () => true } as never),
    createWorkerHookRoutes(new WorkerHookService(fleet)),
    createSessionLifecycleRoutes({
      service: new SessionLifecycleService({
        fleet,
        monitor: new SessionProcessMonitor({ probe: () => true }),
        settlement: { settleCleared: () => undefined },
        lockPathFor: () => "x.lock",
      }),
    }),
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
