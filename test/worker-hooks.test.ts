import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { WorkerHookService, createWorkerHookRoutes } from "../src/bridge/worker-hooks.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";
import { combineHandlers } from "../src/bridge/router.js";
import { ManagerBriefings, ManagerPromptService, ManagerStopService, createManagerHookRoutes } from "../src/bridge/manager-hooks.js";
import { createWorkerLifecycleRoutes } from "../src/bridge/lifecycle.js";

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
  assert.equal(await service.reground(parentId, "C:\\repo"), "You are aboard worker worker-15, implementing issue #15 on branch feat/issue-15. Re-read the issue and spec before continuing.");
  const serialized: unknown = JSON.parse(JSON.stringify(fleet.toPersistenceDto()));
  assert.equal((await import("../src/domain/validation.js")).parseFleetPersistenceDto(serialized).ok, true);
});

test("worker Python hook is silent for non-aboard and wrong-role sessions", () => {
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  for (const env of [{}, { ABOARD_AGENT_ID: "manager", ABOARD_AGENT_TYPE: "manager" }]) {
    const result = spawnSync("uv", ["run", "--no-project", "python", script, "worker-post-compact"], { input: JSON.stringify({ hook_event_name: "PostCompact", compact_summary: "x" }), encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});

test("scaffold registers lifecycle, Agent telemetry, and compact re-grounding", async () => {
  const hooks = JSON.parse(await readFile(join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard-hooks.json"), "utf8")) as Record<string, unknown>;
  for (const event of ["SubagentStart", "SubagentStop", "PostToolUse", "PostCompact", "Stop", "StopFailure"]) assert.ok(event in hooks);
  assert.equal((hooks.PostToolUse as { matcher: string }[])[0]?.matcher, "Agent");
  assert.equal((hooks.SessionStart as unknown[]).length, 2);
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
  const stubGit = { branch: "main", head: "abc1234", dirty: false };
  const briefings = new ManagerBriefings(
    { git: async () => stubGit, github: async () => ({ readyIssues: [], openPullRequests: [], hitlIssues: [], unreviewedMergeCount: 0 }), todoIssue: async () => 12 },
    fleet, lease,
  );
  const handler = combineHandlers(
    createManagerHookRoutes(briefings, new ManagerStopService({ fleet }), new ManagerPromptService(fleet, { spawnInteractive: async () => ({ agentId: "a" }) })),
    createWorkerLifecycleRoutes({ stop: async () => true, stopFailure: async () => true, timeout: async () => true, terminalClosed: async () => true } as never),
    createWorkerHookRoutes(new WorkerHookService(fleet)),
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
