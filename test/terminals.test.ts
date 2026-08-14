import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalController,
  type StartupProofTracker,
  type TerminalCreationOptions,
  type TerminalHandle,
  type TerminalHost,
  type TerminalLifecycleEvent,
} from "../src/claude/terminals.js";
import type { AgentId, SessionId, TerminalId } from "../src/domain/contracts.js";
import { createTerminalRoutes } from "../src/bridge/terminal-routes.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import { SessionStartCancelledError, SessionStartTimeoutError } from "../src/bridge/session-lifecycle.js";

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
    environment: () => ({ port: 4932, token: "secret", workspaceRoot: "C:\\work\\aboard", managerCli: "C:\\work\\aboard\\.aboard\\scripts\\aboard_cli.py", managerBashTimeoutMs: 3_600_000, managerRoadmapReminderBytes: 150_000 }),
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
  // Exhaustive on purpose: a worker is never told the delegation command
  // exists, so `ABOARD_CLI` must be absent here rather than merely unused.
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

  // The Manager's terminal carries the delegation command, and the raised Bash
  // ceiling a foreground launch needs to outlive the tool's ten-minute default.
  controller.create({
    agentId: agent("manager-1"),
    sessionId: session("c15badb6-d6c8-45a6-a59f-e931cd364332"),
    agentType: "manager",
  });
  assert.equal(host.created[1]?.options.env.ABOARD_CLI, "C:\\work\\aboard\\.aboard\\scripts\\aboard_cli.py");
  assert.equal(host.created[1]?.options.env.BASH_MAX_TIMEOUT_MS, "3600000");
});

test("an agent's live terminal is findable without the fleet, so settlement can collect it", () => {
  // Session-death settlement drops the fleet record before closing the
  // terminal; a fleet-based lookup leaked the terminal and made the next launch
  // fail with "already has a live aboard terminal".
  const { controller, host } = setup();
  const agentId = agent("manager-1");
  const created = controller.create({ agentId, sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "manager" });
  assert.equal(controller.liveTerminalForAgent(agentId), created.terminalId);
  assert.equal(controller.liveTerminalForAgent(agent("never-launched")), undefined);
  host.close(host.created[0]!.terminal);
  assert.equal(controller.liveTerminalForAgent(agentId), undefined);
});

test("a released terminal survives the session, stops being aboard's, and frees the relaunch", () => {
  // Ctrl+C twice ends the session inside a shell the user kept on purpose.
  const { controller, host, events } = setup();
  const agentId = agent("manager-1");
  const first = controller.create({ agentId, sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "manager" });
  controller.release(first.terminalId);

  assert.equal(host.created[0]?.terminal.disposed, false, "the terminal is handed back, not killed");
  assert.equal(controller.get(first.terminalId).status, "detached");
  assert.equal(controller.liveTerminalForAgent(agentId), undefined);
  // aboard no longer drives it: no focus, no input, no kill.
  assert.throws(() => controller.show(first.terminalId), /is detached/);
  assert.throws(() => controller.kill(first.terminalId), /is detached/);

  const relaunched = controller.create({ agentId, sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"), agentType: "manager" });
  assert.equal(relaunched.status, "open");

  // Closing the released terminal later must stay silent: the agent has been
  // relaunched, and a stale close event would settle the wrong session.
  const before = events.length;
  host.close(host.created[0]!.terminal);
  assert.equal(events.length, before);
  assert.equal(controller.get(relaunched.terminalId).status, "open");
});

test("releasing is idempotent and never resurrects a closed terminal", () => {
  const { controller, host } = setup();
  const created = controller.create({ agentId: agent("manager-1"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "manager" });
  host.close(host.created[0]!.terminal);
  controller.release(created.terminalId);
  assert.equal(controller.get(created.terminalId).status, "closed");
  controller.release(created.terminalId);
  assert.equal(controller.get(created.terminalId).status, "closed");
});

test("the terminal keeps its default shell name; the aboard label stays on the record", () => {
  // A tab named "aboard: manager" outlives the agent and then lies about it.
  const { controller, host } = setup();
  const created = controller.create({ agentId: agent("agent-6"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "implementer", issueNumber: 6 });
  assert.equal("name" in (host.created[0]?.options ?? {}), false);
  assert.equal(created.name, "aboard: implementer");
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

test("result-delivering sessions carry ABOARD_DELIVERS_RESULT; handed-off ones are focused and silent", () => {
  const { controller, host } = setup();
  // The dual-mode builtin types make this a per-launch property: same type,
  // opposite environment and focus.
  controller.create({
    agentId: agent("explore-auto"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "Explore",
    initialCommand: "claude --agent Explore map the auth flow",
    deliversResult: true,
  });
  assert.equal(host.created[0]!.options.env.ABOARD_DELIVERS_RESULT, "1");
  assert.deepEqual(host.created[0]!.terminal.shows, []);

  controller.create({
    agentId: agent("explore-interactive"),
    sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"),
    agentType: "Explore",
    deliversResult: false,
  });
  assert.equal(host.created[1]!.options.env.ABOARD_DELIVERS_RESULT, undefined);
  assert.deepEqual(host.created[1]!.terminal.shows, [false]);
});

test("bulk restoration can suppress focus for user-facing sessions", () => {
  const { controller, host } = setup();
  controller.create({
    agentId: agent("restored-brainstormer"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "brainstormer",
    focus: false,
  });
  assert.deepEqual(host.created[0]!.terminal.shows, []);
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
    agentId: agent("general-purpose-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "general-purpose",
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
    agentId: "general-purpose-1",
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
    sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"),
    agentType: "pr-doctor-afk",
  }));
  assert.equal(duplicate.status, 409);
});

/** Lets each test decide what the awaited proof does; `cancel` is a no-op. */
class FakeStartupProofs implements StartupProofTracker {
  public readonly armed: Array<{ agentId: AgentId; sessionId: SessionId; timeoutMs: number }> = [];
  public constructor(private readonly verdict: () => Promise<unknown>) {}
  public awaitStarted(agentId: AgentId, sessionId: SessionId, timeoutMs: number): Promise<unknown> {
    this.armed.push({ agentId, sessionId, timeoutMs });
    return this.verdict();
  }
  public cancel(): void {}
}

function setupProofs(verdict: () => Promise<unknown>) {
  const host = new FakeTerminalHost();
  const events: TerminalLifecycleEvent[] = [];
  const notified: Array<{ agentId: AgentId; sessionId: SessionId; timeoutMs: number }> = [];
  const proofs = new FakeStartupProofs(verdict);
  let id = 0;
  const controller = new TerminalController({
    host,
    environment: () => ({ port: 4932, token: "secret", workspaceRoot: "C:\\work\\aboard", managerCli: "C:\\work\\aboard\\.aboard\\scripts\\aboard_cli.py", managerBashTimeoutMs: 3_600_000, managerRoadmapReminderBytes: 150_000 }),
    terminalIdFactory: () => terminal(`terminal-${++id}`),
    now: () => new Date("2026-07-30T10:00:00.000Z"),
    onLifecycleEvent: (event) => events.push(event),
    startupProofs: proofs,
    onStartupTimeout: (agentId, sessionId, timeoutMs) => notified.push({ agentId, sessionId, timeoutMs }),
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { controller, host, proofs, notified, flush };
}

test("a launch with no SessionStart inside its window is reported once, then killed as a failed launch", async () => {
  const { controller, host, proofs, notified, flush } = setupProofs(() =>
    Promise.reject(new SessionStartTimeoutError(agent("manager-1"), 120_000)));
  controller.create({
    agentId: agent("manager-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "manager",
    startupTimeoutMs: 120_000,
  });
  assert.deepEqual(proofs.armed, [{ agentId: agent("manager-1"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), timeoutMs: 120_000 }]);

  await flush();
  // The callback is the launch verdict delivered to the user: it names the
  // agent, the session, and the waiting window so the notification can say
  // *why* the terminal is disappearing.
  assert.deepEqual(notified, [{ agentId: agent("manager-1"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), timeoutMs: 120_000 }]);
  assert.equal(host.created[0]!.terminal.disposed, true);
});

test("a cancelled or settled proof is not a verdict and never kills the terminal", async () => {
  const { controller, host, notified, flush } = setupProofs(() =>
    Promise.reject(new SessionStartCancelledError(agent("manager-1"))));
  controller.create({
    agentId: agent("manager-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "manager",
    startupTimeoutMs: 120_000,
  });
  await flush();
  assert.deepEqual(notified, []);
  assert.equal(host.created[0]!.terminal.disposed, false);
});

test("a launch with no startup timeout armed asks for no proof at all", async () => {
  const { controller, proofs } = setupProofs(() =>
    Promise.reject(new SessionStartTimeoutError(agent("general-purpose-1"), 60_000)));
  controller.create({
    agentId: agent("general-purpose-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "general-purpose",
  });
  assert.equal(proofs.armed.length, 0);
});
