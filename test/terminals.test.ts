import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalController,
  type TerminalCreationOptions,
  type TerminalHandle,
  type TerminalHost,
  type TerminalLifecycleEvent,
} from "../src/claude/terminals.js";
import type { AgentId, SessionId, TerminalId } from "../src/domain/contracts.js";
import { createTerminalRoutes } from "../src/bridge/terminal-routes.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";

class FakeTerminal implements TerminalHandle {
  public readonly sent: Array<{ text: string; addNewLine: boolean | undefined }> = [];
  public readonly shows: Array<boolean | undefined> = [];
  public disposed = false;
  public processId: PromiseLike<number | undefined> = Promise.resolve(8123);
  public exitStatus: { code: number | undefined } | undefined;

  public sendText(text: string, addNewLine?: boolean): void {
    this.sent.push({ text, addNewLine });
  }

  public show(preserveFocus?: boolean): void {
    this.shows.push(preserveFocus);
  }

  public dispose(): void {
    this.disposed = true;
  }
}

class FakeTerminalHost implements TerminalHost {
  public readonly created: Array<{ options: TerminalCreationOptions; terminal: FakeTerminal }> = [];
  #listener: ((terminal: TerminalHandle) => void) | undefined;

  public createTerminal(options: TerminalCreationOptions): TerminalHandle {
    const terminal = new FakeTerminal();
    this.created.push({ options, terminal });
    return terminal;
  }

  public onDidCloseTerminal(listener: (terminal: TerminalHandle) => void): { dispose(): void } {
    this.#listener = listener;
    return { dispose: () => { this.#listener = undefined; } };
  }

  public close(terminal: FakeTerminal, exitCode?: number): void {
    terminal.exitStatus = { code: exitCode };
    this.#listener?.(terminal);
  }
}

const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;

function setup() {
  const host = new FakeTerminalHost();
  const events: TerminalLifecycleEvent[] = [];
  let id = 0;
  const controller = new TerminalController({
    host,
    environment: () => ({ port: 4932, token: "secret", workspaceRoot: "C:\\work\\aboard" }),
    terminalIdFactory: () => terminal(`terminal-${++id}`),
    now: () => new Date("2026-07-30T10:00:00.000Z"),
    sleep: async () => undefined,
    onLifecycleEvent: (event) => events.push(event),
  });
  return { controller, host, events };
}

test("creates one real-terminal record with the complete aboard environment", () => {
  const { controller, host, events } = setup();
  const created = controller.create({
    agentId: agent("agent-6"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "implementer",
    issueNumber: 6,
    initialCommand: "claude --agent implementer --session-id 4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee \"Implement issue 6\"",
  });

  assert.equal(created.terminalId, "terminal-1");
  assert.deepEqual(host.created[0]?.options.env, {
    ABOARD_BRIDGE_PORT: "4932",
    ABOARD_BRIDGE_TOKEN: "secret",
    ABOARD_AGENT_ID: "agent-6",
    ABOARD_SESSION_ID: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee",
    ABOARD_AGENT_TYPE: "implementer",
    ABOARD_WORKSPACE_ROOT: "C:\\work\\aboard",
    ABOARD_ISSUE_NUMBER: "6",
  });
  assert.deepEqual(host.created[0]?.terminal.sent, [{
    text: "claude --agent implementer --session-id 4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee \"Implement issue 6\"",
    addNewLine: true,
  }]);
  assert.deepEqual(host.created[0]?.terminal.shows, []);
  assert.equal(events[0]?.type, "terminal-created");
  assert.throws(() => controller.create({
    agentId: agent("agent-6"),
    sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"),
    agentType: "pr-doctor-afk",
  }), /already has a live aboard terminal/);
});

test("a closed terminal frees the agent for relaunch but keeps session identity fixed", async () => {
  const { controller, host } = setup();
  const agentId = agent("manager-1");
  const first = controller.create({ agentId, sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "manager" });
  host.close(host.created[0]!.terminal);
  assert.equal(controller.get(first.terminalId).status, "closed");

  // Resuming the recorded conversation and starting a fresh one are both valid
  // relaunches of the same Manager identity.
  const resumed = controller.create({ agentId, sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "manager" });
  assert.equal(resumed.status, "open");
  host.close(host.created[1]!.terminal);
  const fresh = controller.create({ agentId, sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"), agentType: "manager" });
  assert.equal(fresh.status, "open");

  // A session id never migrates to a different agent, closed or not.
  assert.throws(() => controller.create({ agentId: agent("manager-2"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "manager" }), /belongs to agent manager-1/);
  assert.throws(() => controller.create({ agentId, sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"), agentType: "manager" }), /already has a live aboard terminal/);
});

test("focuses interactive terminals and exposes only takeover-named input controls", async () => {
  const { controller, host } = setup();
  const created = controller.create({
    agentId: agent("brainstorm-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "brainstormer",
  });
  const native = host.created[0]!.terminal;
  assert.deepEqual(native.shows, [false]);

  controller.sendUserTakeoverText(created.terminalId, "human follow-up", true);
  await controller.sendUserTakeoverKeys(created.terminalId, ["down", "enter"], 0);
  assert.deepEqual(native.sent, [
    { text: "human follow-up", addNewLine: true },
    { text: "\u001b[B", addNewLine: false },
    { text: "\r", addNewLine: false },
  ]);
  assert.equal("sendAutomatedPrompt" in controller, false);
});

test("captures closure once, releases the native handle, and treats a missing pid as information", async () => {
  const { controller, host, events } = setup();
  const created = controller.create({
    agentId: agent("raw-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "raw",
  });
  const native = host.created[0]!.terminal;
  native.processId = new Promise<number | undefined>(() => undefined);
  controller.kill(created.terminalId);
  assert.equal(native.disposed, true);
  host.close(native);
  host.close(native);

  assert.deepEqual(controller.get(created.terminalId), {
    ...created,
    status: "closed",
    closedAt: "2026-07-30T10:00:00.000Z",
    exitCode: null,
  });
  assert.equal((await controller.getWithProcessId(created.terminalId)).processId, null);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], {
    type: "terminal-closed",
    terminalId: "terminal-1",
    agentId: "raw-1",
    sessionId: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee",
    exitCode: null,
    reason: "killed",
    occurredAt: "2026-07-30T10:00:00.000Z",
  });
  assert.throws(() => controller.sendUserTakeoverText(created.terminalId, "late"), /is closed/);
});

test("terminal routes validate creation and reserve send/keys for explicit user takeover", async () => {
  const { controller, host } = setup();
  const handler = createTerminalRoutes(controller);
  const request = (
    method: string,
    path: string,
    body?: unknown,
  ): AuthenticatedBridgeRequest => ({
    method,
    url: new URL(path, "http://127.0.0.1"),
    headers: {},
    body,
    signal: new AbortController().signal,
  });

  const invalid = await handler(request("POST", "/terminals", { agentId: "worker" }));
  assert.equal(invalid.status, 400);

  const created = await handler(request("POST", "/terminals", {
    agentId: "worker",
    sessionId: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee",
    agentType: "implementer",
    issueNumber: 6,
  }));
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes("secret"), false);

  const denied = await handler(request("POST", "/terminals/terminal-1/send", { text: "prompt" }));
  assert.equal(denied.status, 400);
  assert.deepEqual(host.created[0]?.terminal.sent, []);

  const takeover = await handler(request("POST", "/terminals/terminal-1/send", {
    takeover: true,
    text: "user input",
    addNewLine: false,
  }));
  assert.equal(takeover.status, 200);
  assert.deepEqual(host.created[0]?.terminal.sent, [{ text: "user input", addNewLine: false }]);

  const duplicate = await handler(request("POST", "/terminals", {
    agentId: "worker",
    sessionId: "af817a6c-cd41-41e2-a4db-44d3f43cd560",
    agentType: "pr-doctor-afk",
  }));
  assert.equal(duplicate.status, 409);
});
