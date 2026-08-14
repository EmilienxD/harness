import assert from "node:assert/strict";
import test from "node:test";

import { createCliHandler } from "../src/bridge/cli.js";
import { DelegationCoordinator } from "../src/bridge/delegation.js";
import { resolveLaunchConfiguration } from "../src/claude/launch.js";

/** An aboard definition: body plus tool list, both carried as launch flags. */
const definitionFor = (agentName: string, declaredTools: readonly string[]) =>
  resolveLaunchConfiguration({
    agentName,
    systemPrompt: `You are the ${agentName}.`,
    declaredTools,
  });
import { resolvedPromptFromText } from "../src/claude/prompts.js";
import { TerminalController, type TerminalCreationOptions, type TerminalHandle, type TerminalHost } from "../src/claude/terminals.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import { CLI_LAUNCHABLE_AGENT_TYPES, isNamedBuiltinAgentType, type AgentId, type AgentSession, type IsoTimestamp, type SessionId, type TerminalId, type WorkerResult } from "../src/domain/contracts.js";
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

const MANAGER = agent("manager-1");

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
    environment: () => ({
      port: 4823,
      token: "secret",
      workspaceRoot: "C:\\repo",
      managerCli: "C:\\repo\\.aboard\\scripts\\aboard_cli.py",
      managerBashTimeoutMs: 3_600_000,
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
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:\\repo",
    isResumable: async () => true,
    fleet,
    lease,
    terminals,
    managerAgentId: MANAGER,
    shell: "powershell",
    permissionMode: "default",
    // aboard.launch.claudeCommand: a wrapper that takes its own arguments.
    command: () => ["clauder", "run", "kiro", "--"],
    agentIdFactory: () => agent(`worker-${++agentId}`),
    sessionIdFactory: () => session(ids[sessionId++]!),
    configurations: {
      // Mirrors the production source: an aboard definition carries its body and
      // tool list onto the command line, while a builtin type launches as
      // `--agent <name>` against Claude Code's own definition — there being no
      // file for aboard to read, and none for any session to discover.
      get: async (type) => type === "general-purpose"
        ? resolveLaunchConfiguration({})
        : isNamedBuiltinAgentType(type)
          ? resolveLaunchConfiguration({ agentName: type })
          : definitionFor(type, type === "brainstormer" || type === "webresearcher" ? ["Read", "Grep"] : ["Read", "Edit"]),
    },
    prompts: { resolve: async (input) => input.prompt === undefined ? undefined : resolvedPromptFromText(input.prompt) },
    spills: { write: async (spill) => spill.relativePath },
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  const handler = createCliHandler(coordinator, { managerAgentId: MANAGER });
  const post = (path: string, body: unknown, caller: readonly [string | undefined] = [MANAGER]) => handler({
    method: "POST",
    url: new URL(path, "http://127.0.0.1"),
    headers: caller[0] === undefined ? {} : { "x-aboard-agent-id": caller[0] },
    body,
    signal: new AbortController().signal,
  } as AuthenticatedBridgeRequest);
  const launch = (args: unknown = {}) => post("/cli/agent", args);
  return { fleet, lease, host, terminals, coordinator, handler, post, launch };
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
    issueNumber: 19,
  }, at("2026-07-30T10:00:00.000Z"));
  fleet.transition(workerId, { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") }, at("2026-07-30T10:00:00.000Z"));
  await coordinator.resumePersisted(fleet.get(workerId)!);
  assert.match(host.created[0]!.terminal.sent[0] ?? "", /--resume c15badb6/);
  assert.deepEqual(host.created[0]!.terminal.shown, []);
  assert.equal(host.created[0]!.options.env.ABOARD_DELIVERS_RESULT, undefined);
  assert.deepEqual(fleet.get(workerId)?.resultDelivery, { mode: "none" });
  // Restoration is the user reopening their own fleet and hands the worker to
  // them; the write-capable implementer therefore comes back unleased.
  assert.equal(lease.current(), undefined);
});

test("a terminal handed to the user takes no lease and runs beside the holder", async () => {
  const { launch, lease, coordinator } = setup();
  await coordinator.spawn({ type: "implementer", prompt: "Implement issue nine", description: "implement issue nine" });
  const holder = lease.current()?.agentId;
  assert.notEqual(holder, undefined);
  // Both are write-capable, but both
  // are conversations the user drives, so neither takes the lease nor conflicts
  // with the one already held. An opening --prompt names the topic; it does not
  // make the session aboard's to serialize.
  const generalPurpose = await launch({ type: "general-purpose", description: "open general purpose session", interactive: true });
  assert.equal(generalPurpose.status, 200, JSON.stringify(generalPurpose.body));
  const withTopic = await launch({
    type: "general-purpose", description: "drive the auth cleanup", prompt: "Start from src/auth.ts", interactive: true,
  });
  assert.equal(withTopic.status, 200, JSON.stringify(withTopic.body));
  assert.equal(lease.current()?.agentId, holder);
});

test("keeps an automated-only webresearcher paused after its result caller is gone", async () => {
  const context = setup();
  const workerId = agent("persisted-researcher");
  context.fleet.register({
    identity: { agentId: workerId, type: "webresearcher" },
    sessionId: session("c15badb6-d6c8-45a6-a59f-e931cd364332"),
    terminal: { terminalId: terminal("old-terminal"), name: "aboard: webresearcher" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
    resultDelivery: { mode: "tool-result" },
    telemetry,
  }, at("2026-07-30T10:00:00.000Z"));

  await assert.rejects(
    () => context.coordinator.resumePersisted(context.fleet.get(workerId)!),
    /cannot be restored after its result caller is gone/,
  );
  assert.equal(context.host.created.length, 0);
  assert.equal(context.fleet.get(workerId)?.resultDelivery.mode, "tool-result");
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
    managerAgentId: MANAGER, shell: "powershell", permissionMode: "default",
    agentIdFactory: () => agent("unused"), sessionIdFactory: () => session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee"),
    configurations: { get: async () => definitionFor("implementer", ["Read", "Edit"]) },
    prompts: { resolve: async () => undefined }, spills: { write: async (spill) => spill.relativePath },
  });
  await assert.rejects(() => refusing.resumePersisted(context.fleet.get(workerId)!), /no Claude conversation/);
  assert.equal(context.host.created.length, 0);
  assert.equal(context.fleet.get(workerId)?.terminal.terminalId, "old-terminal");
});

test("serves five commands and nothing that fetches state the Manager is already given", async () => {
  const { post } = setup();
  // The roadmap arrives inline in the session-start briefing, so there is no
  // command to fetch it: a round trip for context the Manager already holds is
  // a turn spent on nothing. Fleet awareness is pushed by hooks, and the
  // Manager never drives the UI, so there is no list or focus command either.
  for (const path of ["/cli/get-todo", "/cli/list-agents", "/cli/focus-agent", "/cli/send-to-agent", "/mcp"]) {
    assert.equal((await post(path, {})).status, 404, path);
  }
  for (const path of ["/cli/agent", "/cli/todo", "/cli/auto-run", "/cli/review-pr", "/cli/release-lease"]) {
    assert.notEqual((await post(path, {})).status, 404, path);
  }
});

// The token is in every aboard terminal's environment, so it cannot be what
// separates the Manager from a worker that went looking for the script.
test("refuses every command from any session but the Manager", async () => {
  const { post, fleet } = setup();
  for (const caller of [[undefined], ["worker-1"]] as const) {
    const response = await post("/cli/agent", { type: "general-purpose", description: "open general purpose session", interactive: true }, caller);
    assert.equal(response.status, 403);
    assert.match(JSON.stringify(response.body), /Only the aboard Manager session/);
  }
  assert.deepEqual(fleet.list().filter((entry) => entry.identity.type !== "manager"), []);
});

test("runtime-validates every command boundary and rejects unknown fields", async () => {
  const { post } = setup();
  for (const [path, args] of [
    ["/cli/agent", { type: "general-purpose", prompt: "", description: "do the work" }],
    ["/cli/agent", { type: "bogus", prompt: "work", description: "do the work" }],
    ["/cli/agent", { type: "manager", prompt: "work", description: "launch a second manager" }],
    ["/cli/agent", { type: "general-purpose", description: "too short", interactive: true }],
    ["/cli/agent", { type: "brainstormer", description: "brainstorm the caching design", interactive: "yes" }],
    // A dual-mode type without --interactive is automated, and an automated
    // launch without a prompt is the one combination with no reading.
    ["/cli/agent", { type: "Explore", description: "map the auth flow" }],
    ["/cli/agent", { type: "webresearcher", description: "research current API pricing" }],
    ["/cli/agent", { type: "webresearcher", prompt: "Find current pricing", description: "research current API pricing", interactive: true }],
    ["/cli/todo", { body: "x", reason: "" }],
    ["/cli/review-pr", { pr: 0 }],
    ["/cli/auto-run", { spec: 12 }],
    ["/cli/release-lease", { reason: "" }],
  ] as const) {
    const response = await post(path, args);
    assert.equal(response.status, 400, `${path} ${JSON.stringify(args)}`);
    assert.equal(body(response).ok, false);
  }
});

// The extension owns the implementation loop, so the Manager must not be able to
// reach an implementation agent directly.
test("the agent command cannot launch an implementation agent", async () => {
  const { launch, fleet } = setup();
  assert.deepEqual([...CLI_LAUNCHABLE_AGENT_TYPES].sort(), ["Explore", "brainstormer", "general-purpose", "webresearcher"]);
  for (const type of ["implementer", "pr-doctor-afk", "pr-doctor-hitl"]) {
    const response = await launch({ type, prompt: "work", description: "do the work now" });
    assert.equal(response.status, 400, type);
    assert.match(JSON.stringify(response.body), /--type must be one of/);
  }
  assert.deepEqual(fleet.list().filter((entry) => entry.identity.type !== "manager"), []);
});

// The implementation types left the agent command, but both delivery modes are
// still load-bearing for the auto-run engine, so they are exercised on the
// coordinator.
test("foreground delegation blocks until a result lands, background returns at once", async () => {
  const { post, fleet, coordinator } = setup();
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
  assert.match(JSON.stringify(result(await post("/cli/release-lease", { reason: "user intervention" }))), /released/);
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

test("a lease conflict reaches the command as a readable refusal, not a stack trace", async () => {
  const { launch, coordinator } = setup();
  await coordinator.spawn({ type: "general-purpose", prompt: "Hold the lease", description: "hold the write lease" });
  const refused = await launch({ type: "general-purpose", prompt: "Compete for it", description: "compete for the lease" });
  assert.equal(refused.status, 409);
  const error = (refused.body as { error: { code: string; message: string; details: unknown } }).error;
  assert.equal(error.code, "lease-conflict");
  assert.match(error.message, /worker-1/);
  assert.notEqual(error.details, undefined);
});

test("interactive launch focuses the terminal and expects no result", async () => {
  const { launch, host } = setup();
  const launched = await launch({
    type: "brainstormer", description: "brainstorm the caching design", interactive: true,
  });
  assert.match(JSON.stringify(launched.body), /no agent result/);
  assert.deepEqual(host.created[0]!.terminal.shown, [false]);
});

test("the configured launch command leads every worker command line", async () => {
  const { coordinator, host } = setup();
  await coordinator.spawn({ type: "implementer", prompt: "Implement the change", description: "implement the current change" });
  // The wrapper's own arguments come first; aboard's flags are appended unchanged.
  assert.match(host.created[0]!.terminal.sent[0]!, /^& clauder run kiro -- --session-id .* --system-prompt-file=\.aboard\/runtime\/agents\/implementer\.md /);
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

test("interactive mode makes the prompt optional", async () => {
  const { launch, host } = setup();
  const omitted = await launch({ type: "brainstormer", description: "open a brainstorm session", interactive: true });
  assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
  // No positional argument after the flags: the terminal opens empty.
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /--system-prompt-file=\.aboard\/runtime\/agents\/brainstormer\.md '--tools=Read,Grep'\s*$/);

  const withTopic = await launch({ type: "brainstormer", prompt: "caching layer", description: "brainstorm the caching layer", interactive: true });
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
  assert.equal(host.created.at(-1)!.options.env.ABOARD_DELIVERS_RESULT, "1");
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /--system-prompt-file=\.aboard\/runtime\/agents\/webresearcher\.md/);
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
  assert.equal(host.created.at(-1)!.options.env.ABOARD_DELIVERS_RESULT, "1");
  assert.equal(worker.resultDelivery.mode, "tool-result");

  // Explore is read-only, so it launches concurrently instead of conflicting.
  const background = await launch({
    type: "Explore", prompt: "map the auth flow", description: "map the auth flow", run_in_background: true,
  });
  assert.equal(background.status, 200, JSON.stringify(background.body));
  assert.match(JSON.stringify(background.body), /running/);
  const explorer = fleet.list().find((entry) => entry.identity.type === "Explore")!;
  assert.equal(explorer.resultDelivery.mode, "mailbox");
  assert.equal(host.created.at(-1)!.options.env.ABOARD_DELIVERS_RESULT, "1");
  const explorerCommand = host.created.at(-1)!.terminal.sent.at(-1)!;
  assert.match(explorerCommand, /--agent Explore/);
  assert.match(explorerCommand, /map the auth flow/);
  assert.deepEqual(host.created.at(-1)!.terminal.shown, []);

  coordinator.complete(worker.identity.agentId, success);
  assert.match(JSON.stringify((await foreground).body), /finished/);
  assert.equal(lease.current(), undefined);
});

test("builtin types run interactively: focused, hook-silent, prompt optional", async () => {
  const { launch, host } = setup();
  const launched = await launch({ type: "Explore", description: "browse the auth flow", interactive: true });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  assert.match(JSON.stringify(launched.body), /no agent result/);
  // Focused like any handed-off session, with no result to report and no
  // positional prompt: the user types the first message.
  assert.deepEqual(host.created.at(-1)!.terminal.shown, [false]);
  assert.equal(host.created.at(-1)!.options.env.ABOARD_DELIVERS_RESULT, undefined);
  assert.match(host.created.at(-1)!.terminal.sent.at(-1)!, /--agent Explore\s*$/);

  const withTopic = await launch({
    type: "general-purpose", prompt: "start from src/auth.ts", description: "drive the auth cleanup", interactive: true,
  });
  assert.equal(withTopic.status, 200, JSON.stringify(withTopic.body));
  const command = host.created.at(-1)!.terminal.sent.at(-1)!;
  assert.doesNotMatch(command, /--agent|--system-prompt(?:-file)?/);
  assert.match(command, /start from src\/auth\.ts/);
  assert.equal(host.created.at(-1)!.options.env.ABOARD_DELIVERS_RESULT, undefined);
});

test("an interactive-only brainstormer is launched interactively and the correction is reported", async () => {
  const { launch, host } = setup();
  // The only valid reading of the call, so it is honoured rather than refused —
  // but the Manager must learn it is waiting for a result that cannot arrive.
  const coerced = await launch({ type: "brainstormer", description: "open a brainstorm session" });
  assert.equal(coerced.status, 200, JSON.stringify(coerced.body));
  assert.match(JSON.stringify(coerced.body), /no result will be delivered/);
  assert.match(JSON.stringify(coerced.body), /continue with the user/);
  assert.deepEqual(host.created[0]!.terminal.shown, [false]);

  // Backgrounding an interactive session is meaningless rather than ambiguous.
  const flagged = await launch({
    type: "brainstormer", description: "brainstorm the caching design", interactive: true, run_in_background: true,
  });
  assert.match(JSON.stringify(flagged.body), /--background was ignored/);
  assert.match(JSON.stringify(flagged.body), /handoff/);
});
