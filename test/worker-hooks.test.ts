import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { WorkerHookService, createWorkerHookRoutes } from "../src/bridge/worker-hooks.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";

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
    const result = spawnSync("uv", ["run", "--no-project", "python", script, "/hooks/worker/post-compact"], { input: JSON.stringify({ hook_event_name: "PostCompact", compact_summary: "x" }), encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});

test("scaffold registers lifecycle, Agent telemetry, and both compact re-grounding events", async () => {
  const hooks = JSON.parse(await readFile(join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard-hooks.json"), "utf8")) as Record<string, unknown>;
  for (const event of ["SubagentStart", "SubagentStop", "PostToolUse", "PostCompact", "InstructionsLoaded"]) assert.ok(event in hooks);
  assert.equal((hooks.PostToolUse as { matcher: string }[])[0]?.matcher, "Agent");
  assert.equal((hooks.SessionStart as unknown[]).length, 2);
});
