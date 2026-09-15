import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalController,
  type StartupProofTracker,
  type TerminalCreationOptions,
  type TerminalHandle,
  type TerminalHost,
  type TerminalLifecycleEvent,
} from "../../src/platform/terminals.js";
import type { AgentId, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { createTerminalRoutes } from "../../src/bridge/terminal-routes.js";
import type { AuthenticatedBridgeRequest } from "../../src/bridge/protocol.js";
import { SessionStartCancelledError, SessionStartTimeoutError } from "../../src/bridge/session-lifecycle.js";

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
    shell: "powershell",
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
    issueNumbers: [6],
    completionCommitStartingSha: "1234567890abcdef1234567890abcdef12345678",
    reviewRange: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    initialCommand: "claude --session-id 4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee \"/address-this Address issue 6\"",
  });

  assert.equal(created.terminalId, "terminal-1");
  // Exhaustive on purpose: terminals receive only the Aboard bridge/session environment.
  assert.deepEqual(host.created[0]?.options.env, {
    ABOARD_BRIDGE_PORT: "4932",
    ABOARD_BRIDGE_TOKEN: "secret",
    ABOARD_AGENT_ID: "agent-6",
    ABOARD_SESSION_ID: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee",
    ABOARD_AGENT_TYPE: "implementer",
    ABOARD_WORKSPACE_ROOT: "C:\\work\\aboard",
    ABOARD_ISSUE_NUMBERS: "6",
    ABOARD_WORKER_START_SHA: "1234567890abcdef1234567890abcdef12345678",
    ABOARD_REVIEW_RANGE: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.deepEqual(host.created[0]?.terminal.sent, [{
    text: "cd -LiteralPath 'C:\\work\\aboard'",
    addNewLine: true,
  }, {
    text: "claude --session-id 4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee \"/address-this Address issue 6\"",
    addNewLine: true,
  }]);
  assert.deepEqual(host.created[0]?.terminal.shows, []);
  assert.equal(events[0]?.type, "terminal-created");
  assert.throws(() => controller.create({
    agentId: agent("agent-6"),
    sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"),
    agentType: "reviewer",
  }), /already has a live aboard terminal/);
});

test("a launch given its own directory starts there, cds there, and calls it the workspace", () => {
  const { controller, host } = setup();
  const created = controller.create({
    agentId: agent("agent-7"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "implementer",
    cwd: "C:\\sessions\\run_test\\aboard",
    initialCommand: "claude --add-dir .abd/runtime/agents/agent-7",
  });

  assert.equal(created.cwd, "C:\\sessions\\run_test\\aboard");
  assert.equal(host.created[0]?.options.cwd, "C:\\sessions\\run_test\\aboard");
  assert.deepEqual(host.created[0]?.terminal.sent[0], {
    text: "cd -LiteralPath 'C:\\sessions\\run_test\\aboard'",
    addNewLine: true,
  });
  // Naming the user's checkout here would hand an isolated session the one path
  // the isolation exists to keep out of its reach.
  assert.equal(host.created[0]?.options.env.ABOARD_WORKSPACE_ROOT, "C:\\sessions\\run_test\\aboard");
});

test("an agent's live terminal is findable without the fleet, so settlement can collect it", () => {
  const { controller, host } = setup();
  const agentId = agent("interactive-1");
  const created = controller.create({ agentId, sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "interactive" });
  assert.equal(controller.liveTerminalForAgent(agentId), created.terminalId);
  assert.equal(controller.liveTerminalForAgent(agent("never-launched")), undefined);
  host.close(host.created[0]!.terminal);
  assert.equal(controller.liveTerminalForAgent(agentId), undefined);
});

test("a released terminal survives the session, stops being aboard's, and frees the relaunch", () => {
  // Ctrl+C twice ends the session inside a shell the user kept on purpose.
  const { controller, host, events } = setup();
  const agentId = agent("interactive-1");
  const first = controller.create({ agentId, sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "interactive" });
  controller.release(first.terminalId);

  assert.equal(host.created[0]?.terminal.disposed, false, "the terminal is handed back, not killed");
  assert.equal(controller.get(first.terminalId).status, "detached");
  assert.equal(controller.liveTerminalForAgent(agentId), undefined);
  // aboard no longer drives it: no focus, no input, no kill.
  assert.throws(() => controller.show(first.terminalId), /is detached/);
  assert.throws(() => controller.kill(first.terminalId), /is detached/);

  const relaunched = controller.create({ agentId, sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"), agentType: "interactive" });
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
  const created = controller.create({ agentId: agent("interactive-1"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "interactive" });
  host.close(host.created[0]!.terminal);
  controller.release(created.terminalId);
  assert.equal(controller.get(created.terminalId).status, "closed");
  controller.release(created.terminalId);
  assert.equal(controller.get(created.terminalId).status, "closed");
});

test("several bound issues reach the session as one comma-separated variable, and none as no variable", () => {
  const { controller, host } = setup();
  controller.create({ agentId: agent("agent-7"), sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"), agentType: "Explore", issueNumbers: [6, 9] });
  assert.equal(host.created[0]?.options.env?.ABOARD_ISSUE_NUMBERS, "6,9");
  // An empty list is no attribution, not an empty string a hook would have to
  // tell apart from a real value.
  controller.create({ agentId: agent("agent-8"), sessionId: session("c15badb6-d6c8-45a6-a59f-e931cd364332"), agentType: "Explore", issueNumbers: [] });
  assert.equal("ABOARD_ISSUE_NUMBERS" in (host.created[1]?.options.env ?? {}), false);
});

test("the terminal leaves title policy to VS Code; the aboard label stays on the record", () => {
  // A static role title outlives the session and then lies about it.
  const { controller, host } = setup();
  const created = controller.create({ agentId: agent("agent-6"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "implementer", issueNumbers: [6] });
  assert.equal("name" in (host.created[0]?.options ?? {}), false);
  assert.equal("titleTemplate" in (host.created[0]?.options ?? {}), false);
  assert.equal(created.name, "aboard: implementer");
});

test("a closed terminal frees the agent for relaunch but keeps session identity fixed", async () => {
  const { controller, host } = setup();
  const agentId = agent("interactive-1");
  const first = controller.create({ agentId, sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "interactive" });
  host.close(host.created[0]!.terminal);
  assert.equal(controller.get(first.terminalId).status, "closed");

  // Resuming the recorded conversation and starting a fresh one are both valid
  // relaunches of the same interactive identity.
  const resumed = controller.create({ agentId, sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "interactive" });
  assert.equal(resumed.status, "open");
  host.close(host.created[1]!.terminal);
  const fresh = controller.create({ agentId, sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"), agentType: "interactive" });
  assert.equal(fresh.status, "open");

  // A session id never migrates to a different agent, closed or not.
  assert.throws(() => controller.create({ agentId: agent("interactive-2"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), agentType: "interactive" }), /belongs to agent interactive-1/);
  assert.throws(() => controller.create({ agentId, sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"), agentType: "interactive" }), /already has a live aboard terminal/);
});

test("attended sessions carry ABOARD_ATTENDED independently of reporting", () => {
  const { controller, host } = setup();
  // The dual-mode builtin types make this a per-launch property: same type,
  // opposite environment and focus.
  controller.create({
    agentId: agent("explore-auto"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "Explore",
    initialCommand: "claude --agent Explore map the auth flow",
    attended: false,
  });
  assert.equal(host.created[0]!.options.env.ABOARD_ATTENDED, undefined);
  assert.deepEqual(host.created[0]!.terminal.shows, []);

  controller.create({
    agentId: agent("explore-interactive"),
    sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"),
    agentType: "Explore",
    attended: true,
  });
  assert.equal(host.created[1]!.options.env.ABOARD_ATTENDED, "1");
  assert.deepEqual(host.created[1]!.terminal.shows, [false]);
});

test("manual delegation mode is present before the child's first hook", () => {
  const { controller, host } = setup();
  controller.create({
    agentId: agent("manual-auto"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "General",
    executionMode: "auto",
    harnessRequestId: "request-7",
  });

  assert.equal(host.created[0]!.options.env.HARNESS_EXECUTION_MODE, "auto");
  assert.equal(host.created[0]!.options.env.HARNESS_REQUEST_ID, "request-7");
});

test("bulk restoration can suppress focus for user-facing sessions", () => {
  const { controller, host } = setup();
  controller.create({
    agentId: agent("restored-interactive"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "interactive",
    focus: false,
  });
  assert.deepEqual(host.created[0]!.terminal.shows, []);
});

test("focuses interactive terminals and exposes only takeover-named input controls", async () => {
  const { controller, host } = setup();
  const created = controller.create({
    agentId: agent("interactive-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "interactive",
  });
  const native = host.created[0]!.terminal;
  assert.deepEqual(native.shows, [false]);

  controller.sendUserTakeoverText(created.terminalId, "human follow-up", true);
  await controller.sendUserTakeoverKeys(created.terminalId, ["down", "enter"], 0);
  assert.deepEqual(native.sent, [
    { text: "cd -LiteralPath 'C:\\work\\aboard'", addNewLine: true },
    { text: "human follow-up", addNewLine: true },
    { text: "\u001b[B", addNewLine: false },
    { text: "\r", addNewLine: false },
  ]);
  assert.equal("sendAutomatedPrompt" in controller, false);
});

test("captures closure once, releases the native handle, and treats a missing pid as information", async () => {
  const { controller, host, events } = setup();
  const created = controller.create({
    agentId: agent("interactive-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "interactive",
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
    agentId: "interactive-1",
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
    issueNumbers: [6],
  }));
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes("secret"), false);

  const denied = await handler(request("POST", "/terminals/terminal-1/send", { text: "prompt" }));
  assert.equal(denied.status, 400);
  assert.deepEqual(host.created[0]?.terminal.sent, [{ text: "cd -LiteralPath 'C:\\work\\aboard'", addNewLine: true }]);

  const takeover = await handler(request("POST", "/terminals/terminal-1/send", {
    takeover: true,
    text: "user input",
    addNewLine: false,
  }));
  assert.equal(takeover.status, 200);
  assert.deepEqual(host.created[0]?.terminal.sent, [
    { text: "cd -LiteralPath 'C:\\work\\aboard'", addNewLine: true },
    { text: "user input", addNewLine: false },
  ]);

  const duplicate = await handler(request("POST", "/terminals", {
    agentId: "worker",
    sessionId: session("af817a6c-cd41-41e2-a4db-44d3f43cd560"),
    agentType: "reviewer",
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
    shell: "powershell",
    environment: () => ({ port: 4932, token: "secret", workspaceRoot: "C:\\work\\aboard" }),
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
    Promise.reject(new SessionStartTimeoutError(agent("interactive-1"), 120_000)));
  controller.create({
    agentId: agent("interactive-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "interactive",
    startupTimeoutMs: 120_000,
  });
  assert.deepEqual(proofs.armed, [{ agentId: agent("interactive-1"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), timeoutMs: 120_000 }]);

  await flush();
  assert.deepEqual(notified, [{ agentId: agent("interactive-1"), sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"), timeoutMs: 120_000 }]);
  assert.equal(host.created[0]!.terminal.disposed, true);
});

test("a cancelled or settled proof is not a verdict and never kills the terminal", async () => {
  const { controller, host, notified, flush } = setupProofs(() =>
    Promise.reject(new SessionStartCancelledError(agent("interactive-1"))));
  controller.create({
    agentId: agent("interactive-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "interactive",
    startupTimeoutMs: 120_000,
  });
  await flush();
  assert.deepEqual(notified, []);
  assert.equal(host.created[0]!.terminal.disposed, false);
});

test("a launch with no startup timeout armed asks for no proof at all", async () => {
  const { controller, proofs } = setupProofs(() =>
    Promise.reject(new SessionStartTimeoutError(agent("interactive-1"), 60_000)));
  controller.create({
    agentId: agent("interactive-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "interactive",
  });
  assert.equal(proofs.armed.length, 0);
});

test("shared orchestration can await the one proof already armed by terminal creation", async () => {
  let resolveProof: ((value: unknown) => void) | undefined;
  const { controller, proofs } = setupProofs(() => new Promise((resolve) => { resolveProof = resolve; }));
  controller.create({
    agentId: agent("chatgpt-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "interactive",
    startupTimeoutMs: 120_000,
  });

  const pending = controller.waitForStartup(agent("chatgpt-1"));
  assert.equal(proofs.armed.length, 1);
  assert.ok(pending !== undefined);
  resolveProof?.({ sessionId: "actual" });
  assert.deepEqual(await pending, { sessionId: "actual" });
  assert.equal(proofs.armed.length, 1);
  assert.equal(controller.waitForStartup(agent("chatgpt-1")), undefined);
});

test("startup ownership is published after proof is armed and before the command is sent", () => {
  const { controller, host, proofs } = setupProofs(() => new Promise(() => undefined));
  let published = false;
  controller.create({
    agentId: agent("chatgpt-1"),
    sessionId: session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    agentType: "interactive",
    initialCommand: "codex",
    startupTimeoutMs: 120_000,
  }, () => {
    assert.equal(proofs.armed.length, 1);
    assert.deepEqual(host.created[0]?.terminal.sent, []);
    published = true;
  });

  assert.equal(published, true);
  assert.equal(host.created[0]?.terminal.sent.at(-1)?.text, "codex");
});
