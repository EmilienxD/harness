import assert from "node:assert/strict";
import test from "node:test";

import { createMcpHandler, CORE_MCP_TOOLS } from "../src/bridge/mcp.js";
import { DelegationCoordinator } from "../src/bridge/delegation.js";
import { resolveLaunchConfiguration } from "../src/claude/launch.js";
import { resolvedPromptFromText } from "../src/claude/prompts.js";
import { TerminalController, type TerminalCreationOptions, type TerminalHandle, type TerminalHost } from "../src/claude/terminals.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId, WorkerResult } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";

class FakeTerminal implements TerminalHandle {
  public processId = Promise.resolve(1);
  public exitStatus: { code: number | undefined } | undefined;
  public readonly shown: Array<boolean | undefined> = [];
  public readonly sent: string[] = [];
  public sendText(text: string): void { this.sent.push(text); }
  public show(preserveFocus?: boolean): void { this.shown.push(preserveFocus); }
  public dispose(): void {}
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

function managerSession(): AgentSession {
  return {
    identity: { agentId: agent("manager-1"), type: "manager" },
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
  fleet.transition(
    agent("manager-1"),
    { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") },
    at("2026-07-30T10:00:00.000Z"),
  );
  const lease = new WriteLease();
  const host = new FakeHost();
  let terminalId = 0;
  const terminals = new TerminalController({
    host,
    environment: () => ({ port: 4823, token: "secret", workspaceRoot: "C:\\repo" }),
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
  const coordinator = new DelegationCoordinator({
    fleet,
    lease,
    terminals,
    managerAgentId: agent("manager-1"),
    shell: "powershell",
    permissionMode: "default",
    // aboard.launch.claudeCommand: a wrapper that takes its own arguments.
    command: () => ["clauder", "run", "kiro", "--"],
    agentIdFactory: () => agent(`worker-${++agentId}`),
    sessionIdFactory: () => session(ids[sessionId++]!),
    configurations: {
      get: async (type) => type === "brainstormer"
        ? resolveLaunchConfiguration({ agentName: type, declaredTools: ["Read", "Grep"] })
        : type === "raw"
          ? resolveLaunchConfiguration({})
          : resolveLaunchConfiguration({ agentName: type, declaredTools: ["Read", "Edit"] }),
    },
    prompts: { resolve: async (input) => input.prompt === undefined ? undefined : resolvedPromptFromText(input.prompt) },
    spills: { write: async (spill) => spill.relativePath },
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  const handler = createMcpHandler(coordinator);
  const call = (name: string, args: unknown = {}) => handler({
    method: "POST",
    url: new URL("/mcp", "http://127.0.0.1"),
    headers: {},
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    signal: new AbortController().signal,
  } as AuthenticatedBridgeRequest);
  return { fleet, lease, host, terminals, coordinator, handler, call };
}

function resultBody(response: Awaited<ReturnType<ReturnType<typeof createMcpHandler>>>): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

test("publishes six distinct core tools and the one-hour timeout expectation", async () => {
  const { handler, call } = setup();
  assert.equal(CORE_MCP_TOOLS.length, 6);
  assert.equal(new Set(CORE_MCP_TOOLS.map((tool) => tool.name)).size, 6);
  // Delivery timing and delivery existence are flags on one launch tool. Near
  // identical descriptions are what the Manager kept selecting between wrongly.
  for (const removed of ["spawn_agent", "spawn_interactive_agent"]) {
    assert.equal(CORE_MCP_TOOLS.some((tool) => tool.name === removed), false);
  }
  // Messaging a finished agent is not part of v1; the tool stays removed.
  assert.equal(CORE_MCP_TOOLS.some((tool) => tool.name === "send_to_agent"), false);
  assert.match(JSON.stringify((await call("send_to_agent", { agentId: "worker-1", message: "hi" })).body), /Unknown MCP tool send_to_agent/);
  // The Manager never drives the UI; there is no focus tool.
  assert.equal(CORE_MCP_TOOLS.some((tool) => tool.name === "focus_agent"), false);
  assert.match(JSON.stringify((await call("focus_agent", { agentId: "worker-1" })).body), /Unknown MCP tool focus_agent/);
  // Fleet awareness is pushed via hooks, not pulled by polling; there is no
  // list tool to turn into a decision.
  assert.equal(CORE_MCP_TOOLS.some((tool) => tool.name === "list_agents"), false);
  assert.match(JSON.stringify((await call("list_agents")).body), /Unknown MCP tool list_agents/);
  const initialized = await handler({
    method: "POST", url: new URL("/mcp", "http://127.0.0.1"), headers: {},
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, signal: new AbortController().signal,
  });
  assert.match(JSON.stringify(initialized.body), /3600/);
});

test("runtime-validates every tool boundary and rejects unknown fields", async () => {
  const { call } = setup();
  for (const [name, args] of [
    ["run_agent", { type: "raw", prompt: "", description: "do the work" }],
    ["run_agent", { type: "bogus", prompt: "work", description: "do the work" }],
    ["run_agent", { type: "manager", prompt: "work", description: "launch a second manager" }],
    ["run_agent", { type: "raw", description: "too short", interactive: true }],
    ["run_agent", { type: "brainstormer", description: "brainstorm the caching design", interactive: "yes" }],
    ["get_todo", { issue: 12 }],
    ["update_todo", { body: "x", reason: "" }],
    ["review_pr", { pr: 0 }],
    ["start_auto_run", { spec: 12 }],
    ["release_lease", { reason: "" }],
  ] as const) {
    assert.equal("error" in resultBody(await call(name, args)), true, name);
  }
});

// The extension owns the implementation loop, so the Manager must not be able to
// reach an implementation agent directly — not through the schema enum, and not
// through a hand-written call that ignores it.
test("run_agent cannot launch an implementation agent by any route", async () => {
  const { call, fleet } = setup();
  const tool = CORE_MCP_TOOLS.find((entry) => entry.name === "run_agent")!;
  const schema = tool.inputSchema as { properties: { type: { enum: readonly string[] } } };
  assert.deepEqual([...schema.properties.type.enum].sort(), ["brainstormer", "raw"]);
  for (const type of ["implementer", "pr-doctor-afk", "pr-doctor-hitl"]) {
    assert.equal("error" in resultBody(await call("run_agent", { type, prompt: "work", description: "do the work now" })), true, type);
  }
  assert.deepEqual(fleet.list().filter((entry) => entry.identity.type !== "manager"), []);
  assert.match(tool.description, /start_auto_run/);
});

// The implementation types left run_agent, but both delivery modes are still
// load-bearing for the auto-run engine, so they are exercised on the coordinator.
test("foreground delegation blocks until a result lands, background returns at once", async () => {
  const { call, fleet, coordinator } = setup();
  let foregroundSettled = false;
  const foreground = coordinator
    .run({ type: "implementer", prompt: "Implement issue nine", description: "implement issue nine" })
    .then((value) => { foregroundSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(foregroundSettled, false);
  const worker = fleet.list().find((entry) => entry.identity.type === "implementer")!;
  coordinator.complete(worker.identity.agentId, success);
  assert.match(JSON.stringify(await foreground), /finished/);

  const background = await coordinator.spawn({ type: "implementer", prompt: "Implement issue ten", description: "implement issue ten", issue: 10 });
  assert.match(JSON.stringify(background), /running/);
  assert.match(JSON.stringify((await call("release_lease", { reason: "user intervention" })).body), /released/);
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

test("interactive launch focuses the terminal and expects no result", async () => {
  const { call, host } = setup();
  const launched = await call("run_agent", {
    type: "brainstormer", description: "brainstorm the caching design", interactive: true,
  });
  assert.match(JSON.stringify(launched.body), /no agent result/);
  assert.deepEqual(host.created[0]!.terminal.shown, [false]);
});

test("the configured launch command leads every worker command line", async () => {
  const { coordinator, host } = setup();
  await coordinator.spawn({ type: "implementer", prompt: "Implement the change", description: "implement the current change" });
  // The wrapper's own arguments come first; aboard's flags are appended unchanged.
  assert.match(host.created[0]!.terminal.sent[0]!, /^& clauder run kiro -- --session-id .* --agent implementer /);
});

test("an auto-run launch marks the tree it is expected to leave dirty", async () => {
  const { coordinator, fleet } = setup();
  void coordinator.runAutomated({ type: "implementer", prompt: "Implement issue nine", description: "implement issue nine", expectsUncommittedTree: true });
  await new Promise((resolve) => setImmediate(resolve));
  const worker = fleet.list().find((entry) => entry.identity.type === "implementer")!;
  // A dirty tree is this agent's success state, not a `no-commit` failure, and
  // the flag is what tells the lifecycle reconciler so.
  assert.equal(worker.expectsUncommittedTree, true);
  assert.equal(worker.resultDelivery.mode, "tool-result");
});

test("interactive mode makes prompt optional at both the schema and runtime boundary", async () => {
  const tool = CORE_MCP_TOOLS.find((entry) => entry.name === "run_agent");
  assert.ok(tool);
  const schema = tool.inputSchema as { required: string[]; properties: Record<string, { description: string }> };
  // Only interactive launches may omit the prompt, which JSON Schema cannot
  // express conditionally; the parser carries that half of the contract.
  assert.deepEqual(schema.required, ["type", "description"]);
  assert.match(schema.properties.prompt!.description, /Required unless interactive is true/);
  assert.match(schema.properties.interactive!.description, /No result is ever delivered/);
  assert.match(schema.properties.run_in_background!.description, /Ignored when interactive is true/);

  const { call, host } = setup();
  const omitted = resultBody(await call("run_agent", { type: "brainstormer", description: "open a brainstorm session", interactive: true }));
  assert.equal("error" in omitted, false, JSON.stringify(omitted));
  // No positional argument after the flags: the terminal opens empty.
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /--agent brainstormer\s*$/);

  const withTopic = resultBody(await call("run_agent", { type: "brainstormer", prompt: "caching layer", description: "brainstorm the caching layer", interactive: true }));
  assert.equal("error" in withTopic, false, JSON.stringify(withTopic));
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /caching layer/);
});

test("an interactive-only type is launched interactively and the correction is reported", async () => {
  const { call, host } = setup();
  // The only valid reading of the call, so it is honoured rather than refused —
  // but the Manager must learn it is waiting for a result that cannot arrive.
  const coerced = resultBody(await call("run_agent", { type: "raw", description: "open a raw session" }));
  assert.equal("error" in coerced, false, JSON.stringify(coerced));
  assert.match(JSON.stringify(coerced), /no result will be delivered/);
  assert.match(JSON.stringify(coerced), /continue with the user/);
  assert.deepEqual(host.created[0]!.terminal.shown, [false]);

  // Backgrounding an interactive session is meaningless rather than ambiguous.
  const flagged = resultBody(await call("run_agent", {
    type: "brainstormer", description: "brainstorm the caching design", interactive: true, run_in_background: true,
  }));
  assert.match(JSON.stringify(flagged), /run_in_background was ignored/);
  assert.match(JSON.stringify(flagged), /handoff/);
});
