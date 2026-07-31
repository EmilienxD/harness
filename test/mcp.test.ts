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
    agentIdFactory: () => agent(`worker-${++agentId}`),
    sessionIdFactory: () => session(ids[sessionId++]!),
    configurations: {
      get: async (type) => type === "reviewer" || type === "brainstormer"
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

test("publishes ten distinct core tools and the one-hour timeout expectation", async () => {
  const { handler } = setup();
  assert.equal(CORE_MCP_TOOLS.length, 10);
  assert.equal(new Set(CORE_MCP_TOOLS.map((tool) => tool.name)).size, 10);
  const initialized = await handler({
    method: "POST", url: new URL("/mcp", "http://127.0.0.1"), headers: {},
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, signal: new AbortController().signal,
  });
  assert.match(JSON.stringify(initialized.body), /3600/);
});

test("runtime-validates every tool boundary and rejects unknown fields", async () => {
  const { call } = setup();
  for (const [name, args] of [
    ["run_agent", { type: "implementer", prompt: "", description: "do the work" }],
    ["spawn_agent", { type: "bogus", prompt: "work", description: "do the work" }],
    ["spawn_interactive_agent", { type: "raw", description: "too short" }],
    ["list_agents", { surprise: true }],
    ["send_to_agent", { agentId: "", message: "hello" }],
    ["focus_agent", { agentId: "x", extra: true }],
    ["get_todo", { issue: 12 }],
    ["update_todo", { body: "x", reason: "" }],
    ["review_pr", { pr: 0 }],
    ["release_lease", { reason: "" }],
  ] as const) {
    assert.equal("error" in resultBody(await call(name, args)), true, name);
  }
});

test("foreground waits for its matching result while background returns immediately", async () => {
  const { call, fleet, coordinator } = setup();
  let foregroundSettled = false;
  const foreground = Promise.resolve(call("run_agent", {
    type: "reviewer", prompt: "Review issue nine", description: "review issue nine",
  })).then((value) => { foregroundSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(foregroundSettled, false);
  const foregroundAgent = fleet.list().find((entry) => entry.identity.type === "reviewer")!;
  coordinator.complete(foregroundAgent.identity.agentId, success);
  assert.match(JSON.stringify((await foreground).body), /finished/);

  const background = await call("spawn_agent", {
    type: "implementer", prompt: "Implement issue nine", description: "implement issue nine", issue: 9,
  });
  assert.match(JSON.stringify(background.body), /running/);
});

test("lease conflicts fail immediately with holder details and release is audited", async () => {
  const { call } = setup();
  await call("spawn_agent", {
    type: "implementer", prompt: "Implement first task", description: "implement first task",
  });
  const conflict = await call("spawn_agent", {
    type: "fixer", prompt: "Fix second task", description: "fix second task now",
  });
  assert.match(JSON.stringify(conflict.body), /lease-conflict/);
  assert.match(JSON.stringify(conflict.body), /worker-1/);
  assert.match(JSON.stringify((await call("release_lease", { reason: "user intervention" })).body), /released/);
});

test("interactive launch focuses the terminal, expects no result, and fleet/focus tools inspect it", async () => {
  const { call, host } = setup();
  const launched = await call("spawn_interactive_agent", {
    type: "brainstormer", description: "brainstorm the caching design",
  });
  assert.match(JSON.stringify(launched.body), /no agent result/);
  assert.deepEqual(host.created[0]!.terminal.shown, [false]);
  assert.match(JSON.stringify((await call("list_agents")).body), /brainstormer/);
  await call("focus_agent", { agentId: "worker-1" });
  assert.equal(host.created[0]!.terminal.shown.length, 2);
});

test("send resumes a finished session in a new terminal through CLI arguments", async () => {
  const { call, host, fleet, coordinator } = setup();
  await call("spawn_agent", {
    type: "reviewer", prompt: "Review the change", description: "review the current change",
  });
  const worker = fleet.get(agent("worker-1"))!;
  host.close(0);
  coordinator.complete(worker.identity.agentId, success);
  const resumed = await call("send_to_agent", { agentId: "worker-1", message: "Check the updated diff" });
  assert.match(JSON.stringify(resumed.body), /running/);
  assert.match(host.created[1]!.terminal.sent[0]!, /--resume/);
  assert.match(host.created[1]!.terminal.sent[0]!, /Check the updated diff/);
});
