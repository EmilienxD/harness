import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { ManagerBriefings, ManagerStopService, createManagerHookRoutes, HOOK_OUTPUT_LIMIT } from "../src/bridge/manager-hooks.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId, WorkerResult } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;
const timestamp = at("2026-07-30T12:00:00.000Z");

function manager(fleet: FleetRegistry): AgentId {
  const id = agent("manager-1");
  fleet.register({
    identity: { agentId: id, type: "manager" }, sessionId: session("140b5c21-eb37-4147-b5cb-6a5ca2592146"),
    terminal: { terminalId: terminal("manager-terminal"), name: "manager" }, lifecycle: { status: "starting", startedAt: timestamp },
    resultDelivery: { mode: "none" }, telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  }, timestamp);
  fleet.transition(id, { status: "running", startedAt: timestamp }, timestamp);
  return id;
}

function worker(fleet: FleetRegistry, managerAgentId: AgentId, status: AgentSession["lifecycle"]["status"] = "running"): AgentId {
  const id = agent(`worker-${fleet.list().length}`);
  const lifecycle: AgentSession["lifecycle"] = status === "running"
    ? { status, startedAt: timestamp }
    : { status: "completed", startedAt: timestamp, finishedAt: timestamp, exitCode: 0, lastAssistantMessage: "done" };
  fleet.register({ identity: { agentId: id, type: "implementer" }, sessionId: session(`4db0ed4c-5d9e-4ab5-a493-2b8575ab19e${fleet.list().length}`),
    terminal: { terminalId: terminal(`${id}-terminal`), name: id }, lifecycle: { status: "starting", startedAt: timestamp },
    resultDelivery: { mode: "mailbox", managerAgentId }, telemetry: { totalTokens: 1, totalDurationMs: 2, totalToolUseCount: 3, compactionCount: 0 }, issueNumber: 12 }, timestamp);
  fleet.transition(id, lifecycle, timestamp);
  return id;
}

test("briefing slices are concise, body-free, and fail independently", async () => {
  const fleet = new FleetRegistry(); manager(fleet);
  const briefings = new ManagerBriefings({
    git: async () => ({ branch: "main", head: "abc123", dirty: false }),
    github: async () => { throw new Error("gh unavailable"); },
    todoIssue: async () => 77,
  }, fleet, new WriteLease());
  const signal = new AbortController().signal;
  assert.match(await briefings.render("git", signal), /main.*abc123.*clean/);
  assert.match(await briefings.render("github", signal), /unavailable.*gh unavailable/);
  assert.equal(await briefings.render("todo", signal), "Project TODO is issue #77. Read it with aboard__get_todo when you need it.");
  assert.doesNotMatch(await briefings.render("todo", signal), /body|description|thread/i);
});

test("oversized slices use a bounded preview and file reference", async () => {
  let written = "";
  const briefings = new ManagerBriefings({ git: async () => ({ branch: "x".repeat(HOOK_OUTPUT_LIMIT), head: "h", dirty: true }), github: async () => ({ readyIssues: [], openPullRequests: [], hitlIssues: [], unreviewedMergeCount: 0 }), todoIssue: async () => undefined }, new FleetRegistry(), new WriteLease(), { write: async (_slice, content) => { written = content; return "C:\\runtime\\brief-git.txt"; } });
  const output = await briefings.render("git", new AbortController().signal);
  assert.ok(written.length > HOOK_OUTPUT_LIMIT);
  assert.ok(output.length <= HOOK_OUTPUT_LIMIT);
  assert.match(output, /Full git briefing: C:\\runtime\\brief-git.txt/);
});

test("Manager Stop returns pending results, waits for running work, and permits idle stop", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet); const workerId = worker(fleet, managerId);
  const running = new ManagerStopService({ fleet });
  assert.deepEqual(await running.poll({ agentId: managerId, stopHookActive: false }, new AbortController().signal), { state: "running" });
  fleet.transition(workerId, { status: "completed", startedAt: timestamp, finishedAt: timestamp, exitCode: 0, lastAssistantMessage: "implemented" }, timestamp);
  const result: WorkerResult = { outcome: "succeeded", exitCode: 0, lastAssistantMessage: "implemented", telemetry: { totalTokens: 1, totalDurationMs: 2, totalToolUseCount: 3, compactionCount: 0 } };
  fleet.recordResult(workerId, result, timestamp);
  const delivered = await running.poll({ agentId: managerId, stopHookActive: false }, new AbortController().signal);
  assert.equal(delivered.state, "results");
  assert.match(delivered.state === "results" ? delivered.additionalContext : "", /^At 2026-07-30T/);
  assert.deepEqual(await running.poll({ agentId: managerId, stopHookActive: false }, new AbortController().signal), { state: "idle" });
  assert.deepEqual(await running.poll({ agentId: managerId, stopHookActive: true }, new AbortController().signal), { state: "idle" });
});

test("long poll observes abort and route validates stop input", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet); worker(fleet, managerId);
  const stop = new ManagerStopService({ fleet, waitForChange: (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) });
  const controller = new AbortController(); const pending = stop.poll({ agentId: managerId, stopHookActive: false }, controller.signal); controller.abort();
  assert.deepEqual(await pending, { state: "idle" });
  const briefings = new ManagerBriefings({ git: async () => ({ branch: "main", head: "h", dirty: false }), github: async () => ({ readyIssues: [], openPullRequests: [], hitlIssues: [], unreviewedMergeCount: 0 }), todoIssue: async () => undefined }, fleet, new WriteLease());
  const route = createManagerHookRoutes(briefings, stop);
  const request = (body: unknown): AuthenticatedBridgeRequest => ({ method: "POST", url: new URL("http://127.0.0.1/hooks/manager/stop"), headers: {}, body, signal: new AbortController().signal });
  assert.equal((await route(request({ agentId: managerId }))).status, 400);
});

test("Python Manager hook silently self-guards non-addressed sessions", () => {
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  for (const env of [{}, { ABOARD_AGENT_ID: "worker", ABOARD_AGENT_TYPE: "implementer" }]) {
    const result = spawnSync("python", [script, "/hooks/manager/brief-git"], { input: "{}", encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});

test("hook registration covers cold start, resume, explicit timeouts, and split slices", async () => {
  const hooks = await import("node:fs/promises").then(({ readFile }) => readFile(join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard-hooks.json"), "utf8"));
  const parsed = JSON.parse(hooks) as any;
  assert.match(parsed.SessionStart[0].matcher, /startup/); assert.match(parsed.SessionStart[0].matcher, /resume/);
  assert.deepEqual(parsed.SessionStart[0].hooks.map((hook: any) => hook.timeout), [120, 120, 120, 120]);
  assert.equal(parsed.Stop[0].hooks[0].timeout, 3600);
});
