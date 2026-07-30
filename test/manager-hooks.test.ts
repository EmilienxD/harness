import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { EOL } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ManagerBriefings, ManagerPromptService, ManagerStopService, createManagerHookRoutes, HOOK_OUTPUT_LIMIT } from "../src/bridge/manager-hooks.js";
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
  assert.equal(parsed.UserPromptSubmit[0].hooks[0].timeout, 60);
});

test("Manager prompt route launches both interactive command types and drains ordered notifications once", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  const launches: unknown[] = [];
  let next = 1;
  const prompts = new ManagerPromptService(fleet, { spawnInteractive: async (input) => {
    launches.push(input); return { agentId: `interactive-${next++}` };
  } }, () => new Date("2026-07-30T14:31:00.000Z"));
  assert.deepEqual(await prompts.handle(managerId, "/brainstorm caching layer"), { intercepted: true, message: "Brainstorm session launched and focused." });
  assert.deepEqual(await prompts.handle(managerId, "/raw"), { intercepted: true, message: "Raw session launched and focused." });
  assert.deepEqual(launches, [
    { type: "brainstormer", description: "interactive brainstorm session", prompt: "caching layer" },
    { type: "raw", description: "raw interactive session" },
  ]);
  const drained = await prompts.handle(managerId, "what is the status?");
  assert.match(String(drained.additionalContext), /At 2026-07-30T14:31:00.000Z: you started a brainstormer on "caching layer" \(agent interactive-1\)/);
  assert.match(String(drained.additionalContext), /raw session \(agent interactive-2\)/);
  assert.ok(String(drained.additionalContext).indexOf("interactive-1") < String(drained.additionalContext).indexOf("interactive-2"));
  assert.deepEqual(await prompts.handle(managerId, "and now?"), {});
});

async function runPromptHook(responseStatus: number, responseBody: unknown, prompt: string, token = "secret"): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(responseStatus, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  const child = spawn("python", [script, "/hooks/manager/prompt"], {
    env: { ...process.env, ABOARD_AGENT_ID: "manager-1", ABOARD_AGENT_TYPE: "manager", ABOARD_BRIDGE_PORT: String(address.port), ABOARD_BRIDGE_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }));
  const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return { status, stdout, stderr };
}

test("Python prompt hook erases successful and failed commands with exact output channels", async () => {
  const success = await runPromptHook(200, { intercepted: true, message: "Brainstorm session launched and focused." }, "/brainstorm caching layer");
  assert.deepEqual(success, { status: 2, stdout: "", stderr: `${EOL}Brainstorm session launched and focused.${EOL}` });
  const authFailure = await runPromptHook(401, { ok: false }, "/raw", "wrong-token");
  assert.equal(authFailure.status, 2); assert.equal(authFailure.stdout, ""); assert.ok(authFailure.stderr.startsWith(`${EOL}Aboard did not launch the requested session:`));
});

test("Python prompt hook injects a drained queue on a real prompt", async () => {
  const context = "Since your last message:\nAt 2026-07-30T14:31:00.000Z: launched one.\nAt 2026-07-30T14:36:00.000Z: launched two.";
  const result = await runPromptHook(200, { additionalContext: context }, "what changed?");
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
});

test("aboard-owned launch skills are user-only command shims and raw has no agent definition", async () => {
  const { readFile, access } = await import("node:fs/promises");
  for (const name of ["brainstorm", "raw"]) {
    const skill = await readFile(join(process.cwd(), "assets", "scaffold", ".claude", "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, /disable-model-invocation: true/); assert.match(skill, /argument-hint:/); assert.match(skill, new RegExp(`/${name}`));
  }
  await assert.rejects(access(join(process.cwd(), "assets", "scaffold", ".claude", "agents", "raw.md")));
});
