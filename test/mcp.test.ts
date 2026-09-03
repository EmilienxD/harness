import assert from "node:assert/strict";
import test from "node:test";

import { CORE_MCP_TOOLS, createMcpHandler } from "../src/bridge/mcp.js";
import { DelegationCoordinator } from "../src/bridge/delegation.js";
import { resolveLaunchConfiguration } from "../src/claude/launch.js";

/** An aboard definition: body plus tool list, rewritten per launch under `--add-dir`. */
const definitionFor = (agentName: string, declaredTools: readonly string[]) =>
  resolveLaunchConfiguration({
    agentName,
    systemPrompt: `You are the ${agentName}.`,
    declaredTools,
  });
import { resolvedPromptFromText } from "../src/claude/prompts.js";
import { TerminalController, type TerminalCreationOptions, type TerminalHandle, type TerminalHost } from "../src/claude/terminals.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import { MCP_DEFAULT_AGENT_TYPE, MCP_LAUNCHABLE_AGENT_TYPES, isNamedBuiltinAgentType, type AgentId, type AgentSession, type IsoTimestamp, type SessionId, type TerminalId, type WorkerResult } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease, type SessionObservation } from "../src/domain/lease.js";

class FakeTerminal implements TerminalHandle {
  public processId = Promise.resolve(1);
  public exitStatus: { code: number | undefined } | undefined;
  public readonly shown: Array<boolean | undefined> = [];
  public readonly sent: string[] = [];
  public disposed = false;
  public sendText(text: string): void { this.sent.push(text); }
  public show(preserveFocus?: boolean): void { this.shown.push(preserveFocus); }
  public dispose(): void { this.disposed = true; }
}

class FakeHost implements TerminalHost {
  public readonly created: Array<{ options: TerminalCreationOptions; terminal: FakeTerminal }> = [];
  #close: ((terminal: TerminalHandle) => void) | undefined;
  public createTerminal(options: TerminalCreationOptions): TerminalHandle {
    const terminal = new FakeTerminal();
    this.created.push({ options, terminal });
    return terminal;
  }
  public onDidCloseTerminal(listener: (terminal: TerminalHandle) => void): { dispose(): void } {
    this.#close = listener;
    return { dispose: () => { this.#close = undefined; } };
  }
  public close(index: number, exitCode = 0): void {
    const terminal = this.created[index]!.terminal;
    terminal.exitStatus = { code: exitCode };
    this.#close?.(terminal);
  }
}

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;
const telemetry = { totalTokens: 12, totalDurationMs: 34, totalToolUseCount: 2, compactionCount: 0 };
const success: WorkerResult = { outcome: "succeeded", exitCode: 0, lastAssistantMessage: "finished", telemetry };

const MANAGER = agent("manager-1");
const RUNTIME_ROOT = "C:/storage/runtime";

function managerSession(): AgentSession {
  return {
    identity: { agentId: MANAGER, type: "manager" },
    sessionId: session("140b5c21-eb37-4147-b5cb-6a5ca2592146"),
    terminal: { terminalId: terminal("manager-terminal"), name: "Manager" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
    resultDelivery: { mode: "none" },
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  };
}

function setup() {
  const fleet = new FleetRegistry();
  fleet.register(managerSession(), at("2026-07-30T10:00:00.000Z"));
  fleet.transition(MANAGER, { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") }, at("2026-07-30T10:00:00.000Z"));
  const lease = new WriteLease();
  const host = new FakeHost();
  let terminalId = 0;
  const terminals = new TerminalController({
    host,
    shell: "powershell",
    environment: () => ({
      port: 4823,
      token: "secret",
      workspaceRoot: "C:\\repo",
      runtimeRoot: RUNTIME_ROOT,
      managerMcpTimeoutMs: 3_600_000,
      managerRoadmapReminderBytes: 150_000,
    }),
    terminalIdFactory: () => terminal(`terminal-${++terminalId}`),
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  let agentId = 0;
  let sessionId = 0;
  const ids = [
    "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee",
    "af817a6c-cd41-41e2-a4db-44d3f43cd560",
    "c15badb6-d6c8-45a6-a59f-e931cd364332",
    "d8d40e7e-c465-44de-9896-5a86165cd58f",
  ];
  // Marker-file liveness as the lease's stale check sees it. Agents are live
  // until a test says otherwise, which is what a running fleet looks like.
  const sessionLiveness = new Map<AgentId, SessionObservation>();
  const reclaimed: AgentId[] = [];
  /** Runtime files a launch wrote, and the directory they were rooted at. */
  const spills: { path: string; root: string | undefined }[] = [];
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:\\repo",
    runtimeDirectory: RUNTIME_ROOT,
    isResumable: async () => true,
    fleet,
    lease,
    terminals,
    sessions: { observe: (agentId) => sessionLiveness.get(agentId) ?? "live" },
    onStaleLeaseRecovered: (holder) => { reclaimed.push(holder.agentId); },
    managerAgentId: () => MANAGER,
    mcpConfig: async (agentId, type) => type === "brainstormer" ? `C:\\storage\\agent-mcp\\${agentId}.json` : undefined,
    shell: "powershell",
    disallowedTools: ["mcp__aboard__*"],
    // aboard.launch.claudeCommand: a wrapper that takes its own arguments.
    command: () => ["wrapper", "run", "MyProfile", "--"],
    agentIdFactory: () => agent(`worker-${++agentId}`),
    sessionIdFactory: () => session(ids[sessionId++]!),
    configurations: {
      get: async (type) => type === "general-purpose"
        ? resolveLaunchConfiguration({})
        : isNamedBuiltinAgentType(type)
          ? resolveLaunchConfiguration({ agentName: type })
          : definitionFor(type, type === "brainstormer" ? ["mcp__aboard__*", "Read", "Grep"] : type === "webresearcher" ? ["Read", "Grep"] : ["Read", "Edit"]),
    },
    prompts: { resolve: async (input) => input.prompt === undefined ? undefined : resolvedPromptFromText(input.prompt) },
    spills: {
      write: async (spill, root) => { spills.push({ path: spill.relativePath, root }); return spill.relativePath; },
      prepare: async (plan, root) => { if (plan.agentDefinition !== undefined) spills.push({ path: plan.agentDefinition.relativePath, root }); },
    },
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  const handler = createMcpHandler(coordinator, { fleet });
  const call = (name: string, args: unknown = {}, caller: readonly [string | undefined] = [MANAGER]) =>
    mcpCall(handler, name, args, caller[0]);
  const launch = (args: unknown = {}) => call("run_agent", args);
  return { fleet, lease, host, terminals, coordinator, handler, call, launch, sessionLiveness, reclaimed, spills };
}

async function mcpCall(
  handler: ReturnType<typeof createMcpHandler>,
  name: string,
  args: unknown,
  caller: string | undefined,
): Promise<{ readonly status: number; readonly body?: unknown }> {
  const response = await handler({
    method: "POST",
    url: new URL("/mcp", "http://127.0.0.1"),
    headers: caller === undefined ? {} : { "x-aboard-agent-id": caller },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    signal: new AbortController().signal,
  } as AuthenticatedBridgeRequest);
  if (response.status !== 200) return response;
  const envelope = response.body as { error?: unknown; result?: { structuredContent?: unknown; isError?: boolean } };
  if (envelope.error !== undefined) return { status: 400, body: { ok: false, error: envelope.error } };
  if (envelope.result?.isError === true) return { status: 409, body: { ok: false, error: envelope.result.structuredContent } };
  return { status: 200, body: { ok: true, result: envelope.result?.structuredContent } };
}

async function mcpList(handler: ReturnType<typeof createMcpHandler>, caller: string | undefined): Promise<{ readonly status: number; readonly body?: unknown }> {
  return handler({
    method: "POST",
    url: new URL("/mcp", "http://127.0.0.1"),
    headers: caller === undefined ? {} : { "x-aboard-agent-id": caller },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    signal: new AbortController().signal,
  } as AuthenticatedBridgeRequest);
}

function body(response: { readonly body?: unknown }): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

function result(response: { readonly body?: unknown }): unknown {
  return (response.body as { result?: unknown }).result;
}

test("restores a persisted worker with --resume, no new prompt, no focus, and no lease", async () => {
  const { fleet, host, coordinator, lease } = setup();
  const workerId = agent("persisted-worker");
  const sessionId = session("c15badb6-d6c8-45a6-a59f-e931cd364332");
  fleet.register({
    identity: { agentId: workerId, type: "implementer" },
    sessionId,
    terminal: { terminalId: terminal("old-terminal"), name: "aboard: implementer #19" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
    resultDelivery: { mode: "tool-result" },
    telemetry,
    chromeEnabled: true,
    issueNumbers: [19],
    autoRunRestricted: true,
  }, at("2026-07-30T10:00:00.000Z"));
  fleet.transition(workerId, { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") }, at("2026-07-30T10:00:00.000Z"));
  await coordinator.resumePersisted(fleet.get(workerId)!);
  assert.match(host.created[0]!.terminal.sent.at(-1) ?? "", /--resume c15badb6/);
  assert.match(host.created[0]!.terminal.sent.at(-1) ?? "", /--chrome/);
  assert.match(host.created[0]!.terminal.sent.at(-1) ?? "", /Bash\(git commit\*\)/);
  assert.match(host.created[0]!.terminal.sent.at(-1) ?? "", /Bash\(gh pr merge\*\)/);
  assert.deepEqual(host.created[0]!.terminal.shown, []);
  assert.equal(host.created[0]!.options.env.ABOARD_ATTENDED, "1");
  assert.deepEqual(fleet.get(workerId)?.resultDelivery, { mode: "none" });
  // Restoration is the user reopening their own fleet and hands the worker to
  // them; the write-capable implementer therefore comes back unleased.
  assert.equal(lease.current(), undefined);
});

test("continuing an auto-run worker resumes the same session with Continue and reacquires its lease", async () => {
  const { fleet, host, coordinator, lease } = setup();
  const workerId = agent("failed-auto-worker");
  const sessionId = session("c15badb6-d6c8-45a6-a59f-e931cd364332");
  fleet.register({
    identity: { agentId: workerId, type: "implementer" },
    sessionId,
    terminal: { terminalId: terminal("old-terminal"), name: "aboard: address issue 19" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
    resultDelivery: { mode: "tool-result" },
    telemetry,
    issueNumbers: [19],
    autoRunRestricted: true,
  }, at("2026-07-30T10:00:30.000Z"));
  fleet.transition(workerId, { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") }, at("2026-07-30T10:00:00.000Z"));
  coordinator.complete(workerId, {
    outcome: "failed",
    failure: { type: "context-exhausted", exitCode: 1, lastAssistantMessage: null },
    telemetry,
  });

  const resumed = coordinator.resumeAutomated(fleet.get(workerId)!, "Continue");
  for (let attempt = 0; attempt < 20 && host.created.length === 0; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lease.current()?.agentId, workerId);
  assert.match(host.created[0]?.terminal.sent.at(-1) ?? "", /--resume c15badb6/);
  assert.match(host.created[0]?.terminal.sent.at(-1) ?? "", /Continue/);
  coordinator.complete(workerId, success);
  const outcome = await resumed;

  assert.equal(outcome.agentId, workerId);
  assert.equal(outcome.sessionId, sessionId);
  assert.equal(outcome.result.outcome, "succeeded");
  assert.equal(lease.current(), undefined);
});

test("restoring an attended mailbox session preserves who it still owes a report", async () => {
  const { fleet, coordinator } = setup();
  const workerId = agent("persisted-interactive");
  fleet.register({
    identity: { agentId: workerId, type: "general-purpose" },
    sessionId: session("c15badb6-d6c8-45a6-a59f-e931cd364332"),
    terminal: { terminalId: terminal("old-terminal"), name: "aboard: experiment" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
    resultDelivery: { mode: "mailbox", recipientAgentId: MANAGER },
    attended: true,
    telemetry,
  }, at("2026-07-30T10:00:00.000Z"));
  fleet.transition(workerId, { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") }, at("2026-07-30T10:00:00.000Z"));

  await coordinator.resumePersisted(fleet.get(workerId)!);

  assert.deepEqual(fleet.get(workerId)?.resultDelivery, { mode: "mailbox", recipientAgentId: MANAGER });
  assert.equal(fleet.reportsOwedTo(MANAGER)[0]?.identity.agentId, workerId);
});

test("a terminal handed to the user takes no lease and runs beside the holder", async () => {
  const { launch, lease, coordinator } = setup();
  await coordinator.spawn({ type: "implementer", prompt: "Address issue nine", description: "address issue nine" });
  const holder = lease.current()?.agentId;
  assert.notEqual(holder, undefined);
  const generalPurpose = await launch({ type: "general-purpose", description: "open general purpose session", interactive: true, run_in_background: true });
  assert.equal(generalPurpose.status, 200, JSON.stringify(generalPurpose.body));
  const withTopic = await launch({
    type: "general-purpose", description: "drive the auth cleanup", prompt: "Start from src/auth.ts", interactive: true, run_in_background: true,
  });
  assert.equal(withTopic.status, 200, JSON.stringify(withTopic.body));
  assert.equal(lease.current()?.agentId, holder);
});

// The 3-6 word label is cosmetic guidance, not a launch gate: an out-of-range
// description is coerced into range and reported as a notice, never refused.
test("an out-of-range description is coerced, not refused", async () => {
  const { launch } = setup();
  const notice = (response: { readonly body?: unknown }) =>
    String((body(response).result as { notice?: unknown }).notice ?? "");

  const long = await launch({
    type: "general-purpose",
    description: "investigate the retry logic centralization across the whole messaging layer",
    interactive: true,
    run_in_background: true,
  });
  assert.equal(long.status, 200, JSON.stringify(long.body));
  assert.match(notice(long), /truncated to "investigate the retry logic centralization across"/);

  const short = await launch({
    type: "general-purpose",
    description: "fix it",
    prompt: "Fix the flaky OAuth login retry",
    interactive: true,
    run_in_background: true,
  });
  assert.equal(short.status, 200, JSON.stringify(short.body));
  assert.match(notice(short), /extended to "fix it Fix"/);

  // A one-word label can also be padded from the prompt.
  const minimal = await launch({
    type: "webresearcher",
    description: "pricing",
    prompt: "Find the current API pricing tiers",
    run_in_background: true,
  });
  assert.equal(minimal.status, 200, JSON.stringify(minimal.body));
  assert.match(notice(minimal), /extended to "pricing Find the"/);

  // With no prompt to draw from, the type itself is the fallback filler.
  const fallback = await launch({
    type: "general-purpose",
    description: "chat",
    interactive: true,
    run_in_background: true,
  });
  assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
  assert.match(notice(fallback), /extended to "chat general-purpose general-purpose"/);
});

test("keeps the automated-only research types paused after their result caller is gone", async () => {
  for (const [type, agentId, sessionId] of [
    ["webresearcher", "persisted-researcher", "c15badb6-d6c8-45a6-a59f-e931cd364332"],
    ["Explore", "persisted-explorer", "2f2f0f4c-1c3e-4c0a-9d2e-3f5f0a1b2c3d"],
  ] as const) {
    const context = setup();
    const workerId = agent(agentId);
    context.fleet.register({
      identity: { agentId: workerId, type },
      sessionId: session(sessionId),
      terminal: { terminalId: terminal("old-terminal"), name: `aboard: ${type}` },
      lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
      resultDelivery: { mode: "tool-result" },
      telemetry,
    }, at("2026-07-30T10:00:00.000Z"));

    await assert.rejects(
      () => context.coordinator.resumePersisted(context.fleet.get(workerId)!),
      /cannot be restored after its result caller is gone/,
      type,
    );
    assert.equal(context.host.created.length, 0, type);
    assert.equal(context.fleet.get(workerId)?.resultDelivery.mode, "tool-result", type);
  }
});

test("keeps a transcript-less persisted worker paused", async () => {
  const context = setup();
  const workerId = agent("persisted-worker");
  const sessionId = session("c15badb6-d6c8-45a6-a59f-e931cd364332");
  context.fleet.register({
    identity: { agentId: workerId, type: "implementer" }, sessionId,
    terminal: { terminalId: terminal("old-terminal"), name: "aboard: implementer" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
    resultDelivery: { mode: "tool-result" }, telemetry,
  }, at("2026-07-30T10:00:00.000Z"));
  const refusing = new DelegationCoordinator({
    workspaceRoot: "C:\\repo", isResumable: async () => false,
    fleet: context.fleet, lease: context.lease, terminals: context.terminals,
    managerAgentId: () => MANAGER, shell: "powershell",
    agentIdFactory: () => agent("unused"), sessionIdFactory: () => session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    configurations: { get: async () => definitionFor("implementer", ["Read", "Edit"]) },
    prompts: { resolve: async () => undefined }, spills: { write: async (spill) => spill.relativePath, prepare: async () => undefined },
  });
  await assert.rejects(() => refusing.resumePersisted(context.fleet.get(workerId)!), /no Claude conversation/);
  assert.equal(context.host.created.length, 0);
  assert.equal(context.fleet.get(workerId)?.terminal.terminalId, "old-terminal");
});

test("the todo verbs pass their arguments through and reject an unknown status", async () => {
  const calls: unknown[] = [];
  const logged: string[] = [];
  const handler = createMcpHandler(
    setup().coordinator,
    {
      fleet: setup().fleet,
      services: {
        log: (message: string) => logged.push(message),
        github: {
          createRoadmapTasks: async (input: unknown) => { calls.push(["create", input]); return { issue: 9, positions: [1, 2], tasks: ["1. [ ] First task", "2. [ ] Second task"], notices: [] }; },
          updateRoadmapTask: async (input: unknown) => { calls.push(["update", input]); return { issue: 9, task: 1, notices: ["2 open issues carry `[AI]-todo`"] }; },
        } as never,
      },
    },
  );
  const call = (name: string, args: unknown) => mcpCall(handler, name, args, MANAGER);

  const created = await call("todo_create", { subjects: ["First task", "Second task"], after: "top" });
  assert.equal(created.status, 200);
  assert.deepEqual(body(created).result, {
    positions: [1, 2],
    issue: 9,
    tasks: ["1. [ ] First task", "2. [ ] Second task"],
  });

  const updated = await call("todo_update", { task: 1, expect: "First task", status: "completed" });
  assert.equal(updated.status, 200);
  const result = (body(updated).result as Record<string, unknown>);
  assert.equal(result.task, 1);
  // An in-place status change renumbers nothing, so no list is spent on it.
  assert.equal("tasks" in result, false);
  assert.match(String(result.notice), /2 open issues carry `\[AI\]-todo`/);
  assert.deepEqual(calls, [
    ["create", { subjects: ["First task", "Second task"], after: "top" }],
    ["update", { task: 1, expect: "First task", status: "completed" }],
  ]);
  // The user-facing line is derived from the operation, which is what dropping
  // `--reason` bought: a narrated reason could disagree with the edit it named.
  assert.deepEqual(logged, [
    'Roadmap #9: 2 task(s) added to the top - "First task", "Second task"',
    "Roadmap #9: task at position 1 marked completed",
  ]);
  assert.equal((await call("todo_update", { task: 1, expect: "First task", status: "in_progress" })).status, 400);
});

test("todo_update takes a numeric position and a required expect, and rejects anything looser", async () => {
  const calls: unknown[] = [];
  const handler = createMcpHandler(
    setup().coordinator,
    {
      fleet: setup().fleet,
      services: {
        github: {
          updateRoadmapTask: async (input: unknown) => { calls.push(input); return { issue: 9, task: 3, notices: [] }; },
          createRoadmapTasks: async () => ({ issue: 9, positions: [1], notices: [] }),
        } as never,
      },
    },
  );
  const call = (name: string, args: unknown) => mcpCall(handler, name, args, MANAGER);

  // `after` is a bare position: it is deliberately unguarded, because a wrong
  // anchor only misplaces a task where a wrong `task` would rewrite one.
  const moved = await call("todo_update", { task: 3, expect: "Document the verbs", after: 1 });
  assert.equal(moved.status, 200);
  assert.deepEqual(calls, [{ task: 3, expect: "Document the verbs", after: 1 }]);

  assert.equal((await call("todo_update", { task: 3 })).status, 400);
  assert.equal((await call("todo_update", { task: 3, status: "completed" })).status, 400);
  // A hash-shaped id is no longer an address, and must not be coerced into one.
  assert.equal((await call("todo_update", { task: "a3f9", expect: "x", status: "completed" })).status, 400);
  assert.equal((await call("todo_update", { task: 0, expect: "x", status: "completed" })).status, 400);
  assert.equal((await call("todo_update", { task: 1.5, expect: "x", status: "completed" })).status, 400);
  assert.equal((await call("todo_update", { task: 3, expect: "  ", status: "completed" })).status, 400);
  assert.equal((await call("todo_update", { task: 3, expect: "x", after: "bottom" })).status, 400);
  assert.equal((await call("todo_create", { subjects: ["A task"], after: "1" })).status, 400);
});

test("serves exactly the current delegation tools and no duplicate state-fetch surface", async () => {
  assert.deepEqual(CORE_MCP_TOOLS.map((tool) => tool.name), [
    "run_agent",
    "todo_create",
    "todo_update",
    "start_auto_run",
    "review_pr",
  ]);
  for (const absent of ["get_todo", "update_todo", "list_agents", "focus_agent", "send_to_agent", "release_lease"]) {
    assert.equal(CORE_MCP_TOOLS.some((tool) => tool.name === absent), false);
  }
});

test("MCP definitions carry a self-contained description for every tool and field", () => {
  for (const tool of CORE_MCP_TOOLS) {
    assert.equal(typeof tool.description, "string", `${tool.name} needs a description`);
    assert.equal(tool.description.trim().length >= 200, true, `${tool.name}'s description is too terse to stand alone`);
    const properties = tool.inputSchema.properties as Record<string, { description?: unknown }> | undefined;
    for (const [name, schema] of Object.entries(properties ?? {})) {
      assert.equal(typeof schema.description, "string", `${tool.name}.${name} needs field guidance`);
      assert.equal((schema.description as string).trim().length >= 20, true, `${tool.name}.${name} field guidance is too terse`);
    }
  }
});

// The token is in every aboard terminal's environment, so it cannot be what
// separates the Manager from a worker that went looking for the script.
test("refuses every MCP call from any session but the Manager", async () => {
  const { call, fleet } = setup();
  for (const caller of [[undefined], ["worker-1"]] as const) {
    const response = await call("run_agent", { type: "general-purpose", description: "open general purpose session", interactive: true }, caller);
    assert.equal(response.status, 403);
    // The refusal names the Manager without disclosing it: the agent id is not
    // echoed back to an unknown caller.
    assert.equal(JSON.stringify(response.body).includes(MANAGER), false);
  }
  assert.deepEqual(fleet.list().filter((entry) => entry.identity.type !== "manager"), []);
});

test("MCP catalogs are role-scoped and roles without a catalog are refused", async () => {
  const { handler, fleet } = setup();
  const brainstormer = agent("brain-1");
  fleet.register({
    ...managerSession(),
    identity: { agentId: brainstormer, type: "brainstormer" },
    sessionId: session("b5190b9d-66f1-4820-a15b-1a39b3349da9"),
    terminal: { terminalId: terminal("brain-terminal"), name: "Brainstormer" },
    resultDelivery: { mode: "mailbox", recipientAgentId: MANAGER },
    attended: true,
  }, at("2026-07-30T10:00:00.000Z"));
  fleet.transition(brainstormer, { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") }, at("2026-07-30T10:00:00.000Z"));

  const listed = await mcpList(handler, brainstormer);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    ((listed.body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((tool) => tool.name),
    ["run_agent", "continue_agent"],
  );
  const manager = await mcpList(handler, MANAGER);
  assert.deepEqual(
    ((manager.body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((tool) => tool.name),
    ["run_agent", "todo_create", "todo_update", "start_auto_run", "review_pr"],
  );

  const leaf = agent("prototype-leaf");
  fleet.register({
    ...managerSession(),
    identity: { agentId: leaf, type: "prototyper" },
    sessionId: session("04db3747-121a-4374-8e37-8b52e45733fa"),
    terminal: { terminalId: terminal("prototype-terminal"), name: "Prototype" },
    resultDelivery: { mode: "mailbox", recipientAgentId: brainstormer },
    attended: true,
  }, at("2026-07-30T10:00:00.000Z"));
  assert.equal((await mcpList(handler, leaf)).status, 403);
});

test("brainstormer run_agent supports background research and automated or attended prototypes", async () => {
  const { handler, fleet, lease, host } = setup();
  const brainstormer = agent("brain-2");
  fleet.register({
    ...managerSession(),
    identity: { agentId: brainstormer, type: "brainstormer" },
    sessionId: session("328e378a-f09f-47cf-8822-0fb7844c13c6"),
    terminal: { terminalId: terminal("brain-terminal-2"), name: "Brainstormer" },
    resultDelivery: { mode: "mailbox", recipientAgentId: MANAGER },
    attended: true,
  }, at("2026-07-30T10:00:00.000Z"));

  const refused = await mcpCall(handler, "run_agent", { type: "general-purpose", prompt: "Edit it", description: "edit the application code" }, brainstormer);
  assert.equal(refused.status, 400);
  const explored = await mcpCall(handler, "run_agent", {
    type: "Explore", prompt: "Map the cache boundary", description: "map cache boundary code", run_in_background: true,
  }, brainstormer);
  assert.equal(explored.status, 200, JSON.stringify(explored.body));
  const exploreSession = fleet.list().find((entry) => entry.identity.type === "Explore");
  assert.deepEqual(exploreSession?.resultDelivery, { mode: "mailbox", recipientAgentId: brainstormer });
  assert.equal(exploreSession?.attended, undefined);

  const prototyped = await mcpCall(handler, "run_agent", {
    type: "prototyper", prompt: "Try the parser API", description: "test parser api behavior", run_in_background: true,
  }, brainstormer);
  assert.equal(prototyped.status, 200, JSON.stringify(prototyped.body));
  const prototypeSession = fleet.list().find((entry) => entry.identity.type === "prototyper");
  assert.deepEqual(prototypeSession?.resultDelivery, { mode: "mailbox", recipientAgentId: brainstormer });
  assert.equal(prototypeSession?.attended, undefined);
  const prototypeCommand = host.created.at(-1)!.terminal.sent.at(-1)!;
  assert.match(prototypeCommand, /Try the parser API/u);
  assert.doesNotMatch(prototypeCommand, /\.abd[\\/]prototypes/u);

  const attended = await mcpCall(handler, "run_agent", {
    type: "prototyper", description: "direct parser api experiment", interactive: true, run_in_background: true,
  }, brainstormer);
  assert.equal(attended.status, 200, JSON.stringify(attended.body));
  const attendedSession = fleet.list().filter((entry) => entry.identity.type === "prototyper").at(-1);
  assert.equal(attendedSession?.attended, true);
  assert.equal(lease.current(), undefined);
});

test("brainstormer research can run in the foreground", async () => {
  const { handler, fleet, coordinator } = setup();
  const brainstormer = agent("brain-foreground");
  fleet.register({
    ...managerSession(),
    identity: { agentId: brainstormer, type: "brainstormer" },
    sessionId: session("448e378a-f09f-47cf-8822-0fb7844c13c6"),
    terminal: { terminalId: terminal("brain-terminal-foreground"), name: "Brainstormer" },
    resultDelivery: { mode: "mailbox", recipientAgentId: MANAGER },
    attended: true,
  }, at("2026-07-30T10:00:00.000Z"));

  let settled = false;
  const response = mcpCall(handler, "run_agent", {
    type: "webresearcher", prompt: "Check the current API", description: "check current api behavior",
  }, brainstormer).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const researcher = fleet.list().find((entry) => entry.identity.type === "webresearcher")!;
  coordinator.complete(researcher.identity.agentId, success);
  assert.equal((await response).status, 200);
});

test("continue_agent reopens the same supported session, re-points its report, and refuses live or one-shot targets", async () => {
  const { coordinator, fleet, host } = setup();
  const brainstormer = agent("brain-continue");
  fleet.register({
    ...managerSession(),
    identity: { agentId: brainstormer, type: "brainstormer" },
    sessionId: session("190e66e0-c01e-41e8-b36e-fb083cce29fb"),
    terminal: { terminalId: terminal("brain-continue-terminal"), name: "Brainstormer" },
    resultDelivery: { mode: "mailbox", recipientAgentId: MANAGER },
    attended: true,
  }, at("2026-07-30T10:00:00.000Z"));

  const continued = await coordinator.continue({
    agentId: agent("old-prototype"),
    type: "prototyper",
    sessionId: session("9fcc5264-4009-4a55-954d-9613f73bf23e"),
    terminalName: "aboard: test parser api behavior",
  }, "Now test malformed input", brainstormer) as Record<string, unknown>;
  assert.equal(continued.agentId, "old-prototype");
  const restored = fleet.get(agent("old-prototype"));
  assert.deepEqual(restored?.resultDelivery, { mode: "mailbox", recipientAgentId: brainstormer });
  assert.equal(restored?.attended, true);
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /--resume 9fcc5264/u);
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /Now test malformed input/u);

  await assert.rejects(
    coordinator.continue({
      agentId: agent("old-prototype"),
      type: "prototyper",
      sessionId: session("9fcc5264-4009-4a55-954d-9613f73bf23e"),
      terminalName: "aboard: test parser api behavior",
    }, "Do more", brainstormer),
    /still live/u,
  );
  await assert.rejects(
    coordinator.continue({
      agentId: agent("one-shot"),
      type: "Explore",
      sessionId: session("78c445df-70d5-4758-8516-e0a027b0842f"),
      terminalName: "aboard: one shot",
    }, "Look again", brainstormer),
    /cannot be continued/u,
  );
});

test("continue_agent preserves a reported session until its spent terminal settles", async () => {
  const { coordinator, fleet, host } = setup();
  const brainstormer = agent("brain-immediate");
  fleet.register({
    ...managerSession(),
    identity: { agentId: brainstormer, type: "brainstormer" },
    sessionId: session("0199db2a-86d8-4b0f-89a1-624ba42d2635"),
    terminal: { terminalId: terminal("brain-immediate-terminal"), name: "Brainstormer" },
    resultDelivery: { mode: "mailbox", recipientAgentId: MANAGER },
    attended: true,
  }, at("2026-07-30T10:00:00.000Z"));

  const launched = await coordinator.spawn({
    type: "webresearcher",
    prompt: "Check the current API behavior",
    description: "check current api behavior",
  }, brainstormer) as { agentId: AgentId; sessionId: SessionId };
  assert.equal(coordinator.complete(launched.agentId, {
    outcome: "succeeded",
    exitCode: 0,
    lastAssistantMessage: "The API supports it.",
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  }), true);

  const target = {
    agentId: launched.agentId,
    type: "webresearcher" as const,
    sessionId: launched.sessionId,
    terminalName: "aboard: check current api behavior",
  };
  await assert.rejects(
    coordinator.continue(target, "Verify the edge case too", brainstormer),
    /has reported and its terminal is still closing/u,
  );
  assert.equal(fleet.get(launched.agentId)?.lifecycle.status, "completed");

  host.close(0);
  const continued = await coordinator.continue(target, "Verify the edge case too", brainstormer) as Record<string, unknown>;
  assert.equal(continued.agentId, launched.agentId);
  assert.equal(host.created.length, 2);
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /Verify the edge case too/u);
});

test("a pre-Manager MCP request is refused without resolving an identity", async () => {
  const context = setup();
  const handler = createMcpHandler(context.coordinator, { fleet: { get: () => undefined } });
  const response = await mcpCall(handler, "run_agent", {
    type: "general-purpose",
    description: "try to launch before the Manager exists",
    interactive: true,
  }, MANAGER);
  assert.equal(response.status, 403);
  assert.deepEqual(context.fleet.list().filter((entry) => entry.identity.type !== "manager"), []);
});

test("runtime-validates every tool boundary and rejects unknown fields", async () => {
  const { call } = setup();
  for (const [name, args] of [
    ["run_agent", { type: "general-purpose", prompt: "", description: "do the work" }],
    ["run_agent", { type: "bogus", prompt: "work", description: "do the work" }],
    ["run_agent", { type: "manager", prompt: "work", description: "launch a second manager" }],
    ["run_agent", { type: "brainstormer", description: "brainstorm the caching design", interactive: "yes" }],
    // An automated launch without a prompt is rejected.
    ["run_agent", { type: "Explore", description: "map the auth flow" }],
    ["run_agent", { type: "Explore", prompt: "Map auth flow", description: "map the auth flow", interactive: true }],
    ["run_agent", { type: "Explore", prompt: "Map auth flow", description: "map the auth flow", chrome: true }],
    ["run_agent", { type: "general-purpose", description: "open browser debugging session", interactive: true, chrome: "yes" }],
    ["run_agent", { type: "general-purpose", description: "open browser debugging session", interactive: true, chrome: true }],
    ["run_agent", { type: "webresearcher", description: "research current API pricing" }],
    ["run_agent", { type: "webresearcher", prompt: "Find current pricing", description: "research current API pricing", interactive: true }],
    // The former `issues` parameter is no longer accepted.
    ["run_agent", { type: "Explore", prompt: "Map auth flow", description: "map the auth flow", issues: 47 }],
    ["run_agent", { type: "Explore", prompt: "Map auth flow", description: "map the auth flow", issue: 47 }],
    ["todo_create", { subjects: [] }],
    ["todo_create", { subjects: ["A task"], reason: "obsolete field" }],
    ["todo_create", { subjects: ["A task"], after: "" }],
    // An update naming no change at all would spend a round trip on nothing.
    ["todo_update", { task: 1, expect: "A task" }],
    ["todo_update", { expect: "A task", status: "completed" }],
    ["todo_update", { task: 1, status: "completed" }],
    ["todo_update", { task: 1, expect: "A task", status: "archived" }],
    ["review_pr", { pr: 0 }],
    ["start_auto_run", { issue: 12 }],
    ["start_auto_run", { chrome: "yes" }],
    ["start_auto_run", { chrome: true }],
  ] as const) {
    const response = await call(name, args);
    assert.equal(response.status, 400, `${name} ${JSON.stringify(args)}`);
    assert.equal(body(response).ok, false);
  }
});

test("start_auto_run accepts no launch options", async () => {
  const { coordinator } = setup();
  const starts: unknown[] = [];
  const handler = createMcpHandler(coordinator, {
    fleet: setup().fleet,
    services: { autoRun: { start: async () => { starts.push("started"); return { started: true }; } } },
  });
  const response = await mcpCall(handler, "start_auto_run", {}, MANAGER);
  assert.equal(response.status, 200);
  assert.deepEqual(starts, ["started"]);
});

// `general-purpose` is the only catch-all in the launchable set, so an omitted
// type is the caller declining to narrow rather than an unknown one to reject.
test("an omitted type launches general-purpose, and a named one still wins", async () => {
  const { launch, fleet } = setup();
  assert.equal(MCP_DEFAULT_AGENT_TYPE, "general-purpose");
  const runAgentSchema = CORE_MCP_TOOLS.find((tool) => tool.name === "run_agent")!.inputSchema as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.equal(
    runAgentSchema.required?.includes("type"),
    false,
  );
  assert.equal(runAgentSchema.properties?.issues, undefined);

  const defaulted = await launch({ prompt: "Audit the retry paths", description: "audit the retry paths", run_in_background: true });
  assert.equal(defaulted.status, 200, JSON.stringify(defaulted.body));
  const named = await launch({ type: "Explore", prompt: "Map the auth flow", description: "map the auth flow", run_in_background: true });
  assert.equal(named.status, 200, JSON.stringify(named.body));

  assert.deepEqual(
    fleet.list().filter((entry) => entry.identity.type !== "manager").map((entry) => entry.identity.type),
    ["general-purpose", "Explore"],
  );
  // Only omission defaults: a type that is present but unlaunchable is still an
  // error, never quietly rewritten into the default.
  for (const type of [null, "", "bogus", "manager", 3]) {
    assert.equal((await launch({ type, prompt: "work", description: "do the work now" })).status, 400, String(type));
  }
});

test("Manager run_agent can launch automated and attended prototypers", async () => {
  const { launch, fleet, lease, host } = setup();

  const automated = await launch({
    type: "prototyper",
    prompt: "Try the parser API",
    description: "test parser api behavior",
    run_in_background: true,
  });
  assert.equal(automated.status, 200, JSON.stringify(automated.body));
  const automatedSession = fleet.list().find((entry) => entry.identity.type === "prototyper");
  assert.deepEqual(automatedSession?.resultDelivery, { mode: "mailbox", recipientAgentId: MANAGER });
  assert.equal(automatedSession?.attended, undefined);
  const prototypeCommand = host.created.at(-1)!.terminal.sent.at(-1)!;
  assert.match(prototypeCommand, /Try the parser API/u);
  assert.doesNotMatch(prototypeCommand, /\.abd[\\/]prototypes/u);

  const attended = await launch({
    type: "prototyper",
    description: "direct parser api experiment",
    interactive: true,
    run_in_background: true,
  });
  assert.equal(attended.status, 200, JSON.stringify(attended.body));
  const attendedSession = fleet.list().filter((entry) => entry.identity.type === "prototyper").at(-1);
  assert.deepEqual(attendedSession?.resultDelivery, { mode: "mailbox", recipientAgentId: MANAGER });
  assert.equal(attendedSession?.attended, true);
  assert.equal(lease.current(), undefined);
});

// The extension owns the implementation loop, so the Manager must not be able to
// reach an implementation agent directly.
test("run_agent cannot launch an implementation agent", async () => {
  const { launch, fleet } = setup();
  assert.deepEqual([...MCP_LAUNCHABLE_AGENT_TYPES].sort(), ["Explore", "brainstormer", "general-purpose", "prototyper", "webresearcher"]);
  for (const type of ["implementer", "pr-doctor-afk", "pr-doctor-hitl"]) {
    const response = await launch({ type, prompt: "work", description: "do the work now" });
    assert.equal(response.status, 400, type);
    assert.equal(body(response).ok, false, type);
  }
  assert.deepEqual(fleet.list().filter((entry) => entry.identity.type !== "manager"), []);
});

test("foreground delegation blocks until a result lands, background returns at once", async () => {
  const { call, fleet, coordinator } = setup();
  let foregroundSettled = false;
  const foreground = coordinator
    .run({ type: "implementer", prompt: "Address issue nine", description: "address issue nine" })
    .then((value) => { foregroundSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(foregroundSettled, false);
  const worker = fleet.list().find((entry) => entry.identity.type === "implementer")!;
  coordinator.complete(worker.identity.agentId, success);
  assert.match(JSON.stringify(await foreground), /finished/);

  const background = await coordinator.spawn({ type: "implementer", prompt: "Address issue ten", description: "address issue ten", issues: [10] });
  assert.match(JSON.stringify(background), /running/);
});

test("lease conflicts fail immediately with holder details", async () => {
  const { coordinator } = setup();
  await coordinator.spawn({ type: "implementer", prompt: "Implement first task", description: "implement first task" });
  await assert.rejects(
    coordinator.spawn({ type: "pr-doctor-afk", prompt: "Fix second task", description: "fix second task now" }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /worker-1/);
      assert.equal((error as { code?: string }).code, "lease-conflict");
      return true;
    },
  );
});

// The lease is reclaimed by the next writer's acquisition, not by an agent
// asking for it: there is no release_lease tool, and this is what replaces it.
test("reclaims a lease whose holder left no terminal and no live session", async () => {
  const { coordinator, host, lease, sessionLiveness, reclaimed } = setup();
  await coordinator.spawn({ type: "implementer", prompt: "Implement first task", description: "implement first task" });
  const ghost = lease.current()!.agentId;
  host.close(0);
  sessionLiveness.set(ghost, "missing");

  await coordinator.spawn({ type: "pr-doctor-afk", prompt: "Fix second task", description: "fix second task now" });
  assert.notEqual(lease.current()?.agentId, undefined);
  assert.notEqual(lease.current()?.agentId, ghost);
  assert.deepEqual(reclaimed, [ghost]);
  assert.deepEqual(
    lease.events().filter((event) => event.type === "stale-released").map((event) => event.holder.agentId),
    [ghost],
  );
});

test("never reclaims a lease while either the terminal or the session is alive", async () => {
  for (const scenario of ["terminal-open", "session-live"] as const) {
    const { coordinator, host, lease, sessionLiveness, reclaimed } = setup();
    await coordinator.spawn({ type: "implementer", prompt: "Implement first task", description: "implement first task" });
    const holder = lease.current()!.agentId;
    if (scenario === "terminal-open") sessionLiveness.set(holder, "missing");
    else host.close(0);

    await assert.rejects(
      coordinator.spawn({ type: "pr-doctor-afk", prompt: "Fix second task", description: "fix second task now" }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "lease-conflict", scenario);
        assert.match(String((error as Error).message), new RegExp(holder), scenario);
        return true;
      },
    );
    assert.equal(lease.current()?.agentId, holder, scenario);
    assert.deepEqual(reclaimed, [], scenario);
  }
});

test("an unobservable session is not a gone one: no liveness source never reclaims", async () => {
  const context = setup();
  await context.coordinator.spawn({ type: "implementer", prompt: "Implement first task", description: "implement first task" });
  const holder = context.lease.current()!.agentId;
  context.host.close(0);
  const unobserved = new DelegationCoordinator({
    workspaceRoot: "C:\\repo",
    fleet: context.fleet, lease: context.lease, terminals: context.terminals,
    managerAgentId: () => MANAGER, shell: "powershell",
    agentIdFactory: () => agent("worker-unobserved"),
    sessionIdFactory: () => session("af817a6c-cd41-41e2-a4db-44d3f43cd560"),
    configurations: { get: async () => definitionFor("pr-doctor-afk", ["Read", "Edit"]) },
    prompts: { resolve: async (input) => input.prompt === undefined ? undefined : resolvedPromptFromText(input.prompt) },
    spills: { write: async (spill) => spill.relativePath, prepare: async () => undefined },
  });
  await assert.rejects(
    unobserved.spawn({ type: "pr-doctor-afk", prompt: "Fix second task", description: "fix second task now" }),
    (error: unknown) => (error as { code?: string }).code === "lease-conflict",
  );
  assert.equal(context.lease.current()?.agentId, holder);
  assert.deepEqual(context.lease.events().filter((event) => event.type === "stale-released"), []);
});

test("a lease conflict reaches the MCP tool as a readable error result", async () => {
  const { launch, coordinator } = setup();
  await coordinator.spawn({ type: "general-purpose", prompt: "Hold the lease", description: "hold the write lease" });
  const refused = await launch({ type: "general-purpose", prompt: "Compete for it", description: "compete for the lease" });
  assert.equal(refused.status, 409);
  // A lease conflict is a typed error carrying the holder: the Manager acts on
  // the structure, never on the phrasing.
  const error = (refused.body as { error: { code: string; message: string; details: { holder?: { agentId?: string } } } }).error;
  assert.equal(error.code, "lease-conflict");
  assert.equal(error.details.holder?.agentId, "worker-1");
});

test("interactive launch focuses the terminal and reports when the user is done", async () => {
  const { launch, host } = setup();
  const launched = await launch({
    type: "brainstormer", description: "brainstorm the caching design", interactive: true, run_in_background: true,
  });
  assert.match(JSON.stringify(launched.body), /report will be delivered/);
  assert.deepEqual(host.created[0]!.terminal.shown, [false]);
});

test("foreground interactive launch blocks until /done returns its report as the tool result", async () => {
  const { launch, fleet, coordinator } = setup();
  let settled = false;
  const pending = launch({
    type: "brainstormer", description: "brainstorm the caching design", interactive: true,
  }).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const interactive = fleet.list().find((entry) => entry.identity.type === "brainstormer")!;
  assert.equal(interactive.attended, true);
  assert.equal(interactive.resultDelivery.mode, "tool-result");

  coordinator.submitReport(interactive.identity.agentId, "Use a bounded cache with explicit invalidation.");
  const response = await pending;
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(JSON.stringify(response.body), /Use a bounded cache with explicit invalidation/);
});

test("the configured launch command leads every worker command line", async () => {
  const { coordinator, host } = setup();
  await coordinator.spawn({ type: "implementer", prompt: "Implement the change", description: "implement the current change" });
  // The wrapper's own arguments come first; aboard's flags are appended unchanged.
  assert.match(host.created[0]!.terminal.sent.at(-1)!, /^& wrapper run MyProfile -- --session-id .* --add-dir C:\/storage\/runtime\/agents\/worker-1 --settings C:\/storage\/runtime\/agents\/worker-1\/settings\.json --agent abd-implementer-worker-1 /);
  // Role alone does not impose auto-run's fence: this launch is Manager-driven.
  assert.doesNotMatch(host.created[0]!.terminal.sent.at(-1)!, /Bash\(git commit\*\)/);
});

test("an auto-run launch marks the tree it is expected to leave dirty and fences git and GitHub writes", async () => {
  const { coordinator, fleet, host } = setup();
  void coordinator.runAutomated({ type: "implementer", prompt: "Address issue nine", description: "address issue nine", expectsUncommittedTree: true });
  await new Promise((resolve) => setImmediate(resolve));
  const worker = fleet.list().find((entry) => entry.identity.type === "implementer")!;
  // A dirty tree is this agent's success state, not a `no-commit` failure, and
  // the flag is what tells the lifecycle reconciler so.
  assert.equal(worker.expectsUncommittedTree, true);
  assert.equal(worker.resultDelivery.mode, "tool-result");
  assert.equal(worker.autoRunRestricted, true);
  const line = host.created[0]!.terminal.sent.at(-1) ?? "";
  assert.match(line, /Bash\(git worktree\*\)/);
  assert.match(line, /Bash\(git commit\*\)/);
  assert.match(line, /Bash\(git push\*\)/);
  assert.match(line, /Bash\(gh issue create\*\)/);
  assert.match(line, /Bash\(gh pr merge\*\)/);
  assert.doesNotMatch(line, /Bash\(git status\*\)/);
  assert.doesNotMatch(line, /Bash\(gh issue view\*\)/);
});

test("aborting an auto-run launch kills its terminal but keeps waiting for lifecycle settlement", async () => {
  const { coordinator, fleet, host } = setup();
  const controller = new AbortController();
  let settled = false;
  const pending = coordinator.runAutomated({
    type: "implementer",
    prompt: "Address issue nine",
    description: "address issue nine",
    expectsUncommittedTree: true,
  }, controller.signal).then((outcome) => { settled = true; return outcome; });
  await new Promise((resolve) => setImmediate(resolve));
  const worker = fleet.list().find((entry) => entry.identity.type === "implementer")!;

  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(host.created[0]!.terminal.disposed, true);
  assert.equal(settled, false, "terminal disposal is a request; lifecycle still owns settlement");

  const killed = { outcome: "failed", failure: { type: "killed", exitCode: null, lastAssistantMessage: null }, telemetry } as const;
  coordinator.complete(worker.identity.agentId, killed);
  assert.deepEqual((await pending).result, killed);
});

test("an isolated launch runs in its own directory, writes its runtime files there, and is denied the user's checkout", async () => {
  const { coordinator, fleet, host, spills } = setup();
  const CHECKOUT = "C:\\sessions\\run_test\\repo";
  void coordinator.runAutomated({
    type: "implementer",
    prompt: "Address issue nine",
    description: "address issue nine",
    expectsUncommittedTree: true,
    isolation: { cwd: CHECKOUT, denyTools: ["Read(//C:/repo/**)", "Edit(//C:/repo/**)"] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(host.created[0]?.options.cwd, CHECKOUT);
  assert.deepEqual(spills, [{ path: `${RUNTIME_ROOT}/agents/worker-1/.claude/agents/abd-implementer-worker-1.md`, root: CHECKOUT }]);
  // The isolation rules join the infrastructure and auto-run denials rather than replacing them.
  const line = host.created[0]!.terminal.sent.at(-1)!;
  assert.match(line, /--disallowedTools 'mcp__aboard__\*,Bash\(git -\*\),/);
  assert.match(line, /,Read\(\/\/C:\/repo\/\*\*\),Edit\(\/\/C:\/repo\/\*\*\)'/);
  // Recorded on the session: nothing else remembers where the conversation is,
  // and reopening it later means resuming it in that directory.
  assert.equal(fleet.list().find((entry) => entry.identity.type === "implementer")?.cwd, CHECKOUT);
});

test("interactive mode makes the prompt optional", async () => {
  const { launch, host } = setup();
  const omitted = await launch({ type: "brainstormer", description: "open a brainstorm session", interactive: true, run_in_background: true });
  assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
  // No positional argument after the flags: the terminal opens empty.
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /--mcp-config 'C:\\storage\\agent-mcp\\worker-1\.json'.*--agent abd-brainstormer-worker-1 --allowedTools 'mcp__aboard__run_agent,mcp__aboard__continue_agent'\s*$/);

  const withTopic = await launch({ type: "brainstormer", prompt: "caching layer", description: "brainstorm the caching layer", interactive: true, run_in_background: true });
  assert.equal(withTopic.status, 200, JSON.stringify(withTopic.body));
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /caching layer/);
});

test("webresearcher runs unattended, reports a result, and takes no lease", async () => {
  const { launch, fleet, lease, host } = setup();
  const launched = await launch({
    type: "webresearcher",
    prompt: "Find the current API pricing from official sources.",
    description: "research current API pricing",
    run_in_background: true,
  });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  assert.match(JSON.stringify(launched.body), /running/);
  const researcher = fleet.list().find((entry) => entry.identity.type === "webresearcher")!;
  assert.equal(researcher.resultDelivery.mode, "mailbox");
  assert.equal(lease.current(), undefined);
  assert.equal(host.created.at(-1)!.options.env.ABOARD_ATTENDED, undefined);
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /--add-dir C:\/storage\/runtime\/agents\/worker-1 --settings C:\/storage\/runtime\/agents\/worker-1\/settings\.json --agent abd-webresearcher-worker-1/);
  assert.deepEqual(host.created.at(-1)!.terminal.shown, []);
});

test("builtin types run unattended: foreground blocks, and read-only Explore runs beside the lease holder", async () => {
  const { launch, fleet, lease, host, coordinator } = setup();
  let foregroundSettled = false;
  const foreground = Promise.resolve(launch({
    type: "general-purpose", prompt: "hunt the retry bug", description: "hunt the retry bug",
  })).then((response) => { foregroundSettled = true; return response; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(foregroundSettled, false);
  const worker = fleet.list().find((entry) => entry.identity.type === "general-purpose")!;
  // A full-tool agent is write-capable: it holds the lease and its session is
  // marked result-delivering for the hooks.
  assert.equal(lease.current()?.agentId, worker.identity.agentId);
  assert.equal(host.created.at(-1)!.options.env.ABOARD_ATTENDED, undefined);
  assert.equal(worker.resultDelivery.mode, "tool-result");

  // Explore is read-only, so it launches concurrently instead of conflicting.
  const background = await launch({
    type: "Explore", prompt: "map the auth flow", description: "map the auth flow", run_in_background: true,
  });
  assert.equal(background.status, 200, JSON.stringify(background.body));
  assert.match(JSON.stringify(background.body), /running/);
  const explorer = fleet.list().find((entry) => entry.identity.type === "Explore")!;
  assert.equal(explorer.resultDelivery.mode, "mailbox");
  assert.equal(host.created.at(-1)!.options.env.ABOARD_ATTENDED, undefined);
  const explorerCommand = host.created.at(-1)!.terminal.sent.at(-1)!;
  assert.match(explorerCommand, /--agent Explore/);
  assert.match(explorerCommand, /map the auth flow/);
  assert.deepEqual(host.created.at(-1)!.terminal.shown, []);

  coordinator.complete(worker.identity.agentId, success);
  assert.match(JSON.stringify((await foreground).body), /finished/);
  assert.equal(lease.current(), undefined);
});

test("a queued launch receives its prompt without making the Manager wait for a report", async () => {
  const { coordinator, fleet, lease, host } = setup();
  const launched = await coordinator.launchQueued({
    type: "general-purpose",
    prompt: "fix the retry bug and commit the result",
    description: "queued retry bug fix",
  });
  const session = fleet.get(launched.agentId)!;

  assert.equal(session.identity.type, "general-purpose");
  assert.equal(session.attended, undefined);
  assert.deepEqual(session.resultDelivery, { mode: "none" });
  assert.equal(lease.current()?.agentId, launched.agentId);
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /fix the retry bug and commit the result/u);
});

test("queue admission is checked under the lease immediately before terminal creation", async () => {
  const { coordinator, lease, host, fleet } = setup();
  await assert.rejects(coordinator.launchQueued({
    type: "general-purpose", prompt: "work", description: "queued general purpose task",
  }, async () => {
    assert.ok(lease.current());
    assert.equal(host.created.length, 0);
    throw new Error("tree became dirty");
  }), /tree became dirty/);
  assert.equal(host.created.length, 0);
  assert.equal(fleet.list().length, 1, "only the Manager remains");
  assert.equal(lease.current(), undefined);
});

test("background general-purpose runs attended, focused, and reports only through /done", async () => {
  const { launch, host } = setup();
  const launched = await launch({ type: "general-purpose", description: "browse the auth flow", interactive: true, run_in_background: true });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  assert.match(JSON.stringify(launched.body), /report will be delivered/);
  // Focused like any handed-off session, with no result to report and no
  // positional prompt: the user types the first message.
  assert.deepEqual(host.created.at(-1)!.terminal.shown, [false]);
  assert.equal(host.created.at(-1)!.options.env.ABOARD_ATTENDED, "1");
  // The default shape: no `--agent`, no system-prompt flag.
  const bare = host.created.at(-1)!.terminal.sent.at(-1)!;
  assert.doesNotMatch(bare, /--agent|--system-prompt(?:-file)?/);
  assert.doesNotMatch(bare, /--(?:no-)?chrome/);

  // The same shape with an opening topic, which names the conversation rather
  // than delivering a task.
  const withTopic = await launch({
    type: "general-purpose", prompt: "start from src/auth.ts", description: "drive the auth cleanup", interactive: true, run_in_background: true,
  });
  assert.equal(withTopic.status, 200, JSON.stringify(withTopic.body));
  const command = host.created.at(-1)!.terminal.sent.at(-1)!;
  assert.doesNotMatch(command, /--agent|--system-prompt(?:-file)?/);
  assert.match(command, /start from src\/auth\.ts/);
  assert.equal(host.created.at(-1)!.options.env.ABOARD_ATTENDED, "1");

});

test("Explore is automated only and cannot be launched interactively", async () => {
  const { launch } = setup();
  const launched = await launch({ type: "Explore", description: "browse the auth flow", interactive: true });
  assert.equal(launched.status, 400);
  assert.equal(body(launched).ok, false);
});

test("an interactive-only brainstormer is launched interactively and the correction is reported", async () => {
  const { launch, host } = setup();
  // The only valid reading of the call, so it is honoured rather than refused —
  // and the Manager is told when its report will arrive.
  const coerced = await launch({ type: "brainstormer", description: "open a brainstorm session", run_in_background: true });
  assert.equal(coerced.status, 200, JSON.stringify(coerced.body));
  assert.match(JSON.stringify(coerced.body), /report will arrive after the user runs \/done/);
  assert.deepEqual(host.created[0]!.terminal.shown, [false]);
  const command = host.created[0]!.terminal.sent.at(-1)!;
  assert.match(command, /--mcp-config/u);
  assert.match(command, /mcp__aboard__run_agent,mcp__aboard__continue_agent/u);
  assert.doesNotMatch(command, /--disallowedTools\s+['"]?mcp__aboard__\*/u);

  // An interactive session can run in the background and report asynchronously.
  const flagged = await launch({
    type: "brainstormer", description: "brainstorm the caching design", interactive: true, run_in_background: true,
  });
  assert.match(JSON.stringify(flagged.body), /handoff/);
});
