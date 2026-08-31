import assert from "node:assert/strict";
import test from "node:test";

import { DelegationCoordinator, DelegationError } from "../src/bridge/delegation.js";
import { ManagerPromptService } from "../src/bridge/manager-hooks.js";
import { ReopenCoordinator, describeReopenOutcome } from "../src/claude/reopen.js";
import { resolveLaunchConfiguration } from "../src/claude/launch.js";
import { resolvedPromptFromText } from "../src/claude/prompts.js";
import { TerminalController, type TerminalCreationOptions, type TerminalHandle, type TerminalHost } from "../src/claude/terminals.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";
import { migrateLegacySessions, type ActivityDto, type LegacySessionRecord } from "../src/domain/activity.js";
import { renderReopenItems, registerReopenCommand, type ReopenQuickPickItem } from "../src/vscode/reopen.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";

interface LegacyLedger {
  readonly version: 1;
  readonly sessions: readonly LegacySessionRecord[];
}

function recordEndedSession(current: LegacyLedger | undefined, entry: LegacySessionRecord): LegacyLedger {
  const previous = (current?.sessions ?? []).filter((session) => session.agentId !== entry.agentId);
  return { version: 1, sessions: [entry, ...previous] };
}

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminalId = (value: string) => value as TerminalId;
const telemetry = { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 };

const BRAINSTORM_SESSION = session("4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee");
const GENERAL_SESSION = session("af817a6c-cd41-41e2-a4db-44d3f43cd560");

class FakeTerminal implements TerminalHandle {
  public processId = Promise.resolve(1);
  public exitStatus: { code: number | undefined } | undefined;
  public disposed = false;
  public readonly shown: Array<boolean | undefined> = [];
  public readonly sent: string[] = [];
  public sendText(text: string): void { this.sent.push(text); }
  public show(preserveFocus?: boolean): void { this.shown.push(preserveFocus); }
  public dispose(): void { this.disposed = true; }
}

class FakeHost implements TerminalHost {
  public readonly created: Array<{ options: TerminalCreationOptions; terminal: FakeTerminal }> = [];
  public createTerminal(options: TerminalCreationOptions): TerminalHandle {
    const terminal = new FakeTerminal();
    this.created.push({ options, terminal });
    return terminal;
  }
  public onDidCloseTerminal(): { dispose(): void } { return { dispose: () => {} }; }
}

function setup(options: {
  readonly ledger?: LegacyLedger;
  readonly activity?: ActivityDto;
  readonly fleet?: FleetRegistry;
  readonly resumable?: (sessionId: SessionId) => boolean;
  /** Every transcript lookup, so a test can assert *where* it was looked for. */
  readonly resumeChecks?: { sessionId: SessionId; cwd: string | undefined }[];
  /** Records each Manager resume the reopen path delegates instead of launching. */
  readonly managerResumes?: string[];
} = {}) {
  const record = (sessionId: SessionId, cwd: string | undefined): boolean => {
    options.resumeChecks?.push({ sessionId, cwd });
    return options.resumable?.(sessionId) ?? true;
  };
  const fleet = options.fleet ?? new FleetRegistry();
  const lease = new WriteLease();
  const host = new FakeHost();
  let nextTerminal = 0;
  const terminals = new TerminalController({
    host,
    shell: "powershell",
    environment: () => ({ port: 4823, token: "secret", workspaceRoot: "C:\\repo", managerMcpTimeoutMs: 3_600_000, managerRoadmapReminderBytes: 150_000 }),
    terminalIdFactory: () => terminalId(`terminal-${++nextTerminal}`),
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:\\repo",
    isResumable: async (sessionId, cwd) => record(sessionId, cwd),
    fleet,
    lease,
    terminals,
    managerAgentId: () => agent("manager-1"),
    shell: "powershell",
    disallowedTools: ["mcp__aboard__*"],
    agentIdFactory: () => agent("unused"),
    sessionIdFactory: () => session("c15badb6-d6c8-45a6-a59f-e931cd364332"),
    configurations: {
      get: async (type) => type === "general-purpose"
        ? resolveLaunchConfiguration({})
        : resolveLaunchConfiguration({ agentName: type, systemPrompt: `You are the ${type}.`, declaredTools: ["Read", "Grep"] }),
    },
    prompts: { resolve: async (input) => input.prompt === undefined ? undefined : resolvedPromptFromText(input.prompt) },
    spills: { write: async (file) => file.relativePath, prepare: async () => undefined },
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  const openTerminals = new Set<string>();
  // Terminals a test declares live for an agent the real controller never
  // created — a fleet record restored from a previous extension host.
  const liveTerminals = new Map<AgentId, TerminalId>();
  const shown: TerminalId[] = [];
  const reopen = new ReopenCoordinator({
    // Production reads the activity store; a legacy ledger reaches it only
    // through the one-time migration, which is exactly what these tests exercise.
    activity: { entries: () => options.activity ?? migrateLegacySessions(undefined, options.ledger?.sessions ?? []) },
    fleet,
    terminals: {
      isOpen: (id) => openTerminals.has(id) || terminals.list().some((entry) => entry.terminalId === id && entry.status === "open"),
      liveTerminalFor: (id) => liveTerminals.get(id) ?? terminals.liveTerminalForAgent(id),
      show: (id) => { shown.push(id); },
    },
    launcher: coordinator,
    isResumable: async (sessionId, cwd) => record(sessionId, cwd),
    reopenManager: async () => { options.managerResumes?.push("resumed"); },
  });
  return { fleet, lease, host, terminals, coordinator, reopen, openTerminals, liveTerminals, shown };
}

test("automated web research is hidden from user reopen but remains available to continue_agent", async () => {
  const webSession = session("516e25a5-b829-47ef-b52a-f091fbcc549a");
  const { reopen } = setup({
    activity: {
      version: 1,
      entries: [{
        kind: "agent",
        id: "agent:web-7:2026-07-30T09:30:00.000Z",
        at: at("2026-07-30T09:30:00.000Z"),
        agentId: agent("web-7"),
        type: "webresearcher",
        description: "research current API pricing",
        outcome: "succeeded",
        continuation: { sessionId: webSession },
      }],
    },
  });

  assert.deepEqual(await reopen.list(), []);
  const continuation = await reopen.findContinuation(agent("web-7"));
  assert.equal(continuation?.resumable, true);
  assert.equal(continuation?.candidate.agentId, "web-7");
  assert.equal(continuation?.candidate.sessionId, webSession);
  assert.equal(continuation?.candidate.type, "webresearcher");
});

function ledgerWith(...entries: readonly { readonly agentId: string; readonly type: AgentSession["identity"]["type"]; readonly sessionId: SessionId; readonly endedAt: string }[]): LegacyLedger {
  return entries.reduce<LegacyLedger | undefined>((current, entry) => recordEndedSession(current, {
    agentId: agent(entry.agentId),
    type: entry.type,
    sessionId: entry.sessionId,
    description: `${entry.type} conversation`,
    endedAt: at(entry.endedAt),
  }), undefined)!;
}

function retainFinishedImplementer(fleet: FleetRegistry, status: "completed" | "failed"): void {
  const agentId = agent("4");
  const startedAt = at("2026-07-30T09:00:00.000Z");
  const finishedAt = at("2026-07-30T09:30:00.000Z");
  fleet.register({
    identity: { agentId, type: "implementer" },
    sessionId: BRAINSTORM_SESSION,
    terminal: { terminalId: terminalId("spent-terminal"), name: "aboard: address issue 34" },
    lifecycle: { status: "starting", startedAt },
    resultDelivery: { mode: "tool-result" },
    telemetry,
    issueNumbers: [34],
    autoRunRestricted: true,
  }, startedAt);
  fleet.transition(agentId, { status: "running", startedAt }, startedAt);
  if (status === "completed") {
    fleet.transition(agentId, { status, startedAt, finishedAt, exitCode: 0, lastAssistantMessage: "done" }, finishedAt);
    fleet.recordResult(agentId, { outcome: "succeeded", exitCode: 0, lastAssistantMessage: "done", telemetry }, finishedAt);
    return;
  }
  const failure = { type: "crashed" as const, exitCode: 1, lastAssistantMessage: "failed" };
  fleet.transition(agentId, { status, startedAt, finishedAt, failure }, finishedAt);
  fleet.recordResult(agentId, { outcome: "failed", failure, telemetry }, finishedAt);
}

for (const status of ["completed", "failed"] as const) {
  test(`a retained ${status} implementer restarts as an attended session`, async () => {
    const fleet = new FleetRegistry();
    retainFinishedImplementer(fleet, status);
    const { reopen, host } = setup({
      fleet,
      ledger: ledgerWith({ agentId: "4", type: "implementer", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
    });

    const outcome = await reopen.reopenLatest();
    assert.equal(outcome.action, "reopened");
    assert.equal(fleet.list().length, 1);
    const restored = fleet.get(agent("4"));
    assert.equal(restored?.sessionId, BRAINSTORM_SESSION);
    assert.equal(restored?.terminal.terminalId, "terminal-1");
    assert.equal(restored?.lifecycle.status, "running");
    assert.equal(restored?.attended, true);
    assert.deepEqual(restored?.resultDelivery, { mode: "none" });
    assert.equal(restored?.lastResult, undefined);
    assert.equal(host.created[0]?.options.env.ABOARD_ATTENDED, "1");
  });
}

test("reopen refuses an incompatible retained identity before creating a terminal", async () => {
  const fleet = new FleetRegistry();
  fleet.register({
    identity: { agentId: agent("4"), type: "brainstormer" },
    sessionId: BRAINSTORM_SESSION,
    terminal: { terminalId: terminalId("spent-terminal"), name: "aboard: brainstorm" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T09:00:00.000Z") },
    resultDelivery: { mode: "none" },
    telemetry,
  }, at("2026-07-30T09:00:00.000Z"));
  const { reopen, host } = setup({
    fleet,
    ledger: ledgerWith({ agentId: "4", type: "implementer", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
  });

  await assert.rejects(
    () => reopen.reopenLatest(),
    (error) => error instanceof DelegationError && error.code === "unknown-agent",
  );
  assert.equal(host.created.length, 0);
});

test("reopen disposes its new terminal when fleet binding unexpectedly fails", async () => {
  class RejectingRestartFleet extends FleetRegistry {
    public override restart(): void { throw new Error("binding failed"); }
  }
  const fleet = new RejectingRestartFleet();
  retainFinishedImplementer(fleet, "completed");
  const { reopen, host } = setup({
    fleet,
    ledger: ledgerWith({ agentId: "4", type: "implementer", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
  });

  await assert.rejects(() => reopen.reopenLatest(), /binding failed/);
  assert.equal(host.created.length, 1);
  assert.equal(host.created[0]?.terminal.disposed, true);
});

test("an ended brainstormer is reopened with its own definition re-emitted, not as a bare --resume", async () => {
  const { reopen, host, fleet, lease } = setup({
    ledger: ledgerWith({ agentId: "7", type: "brainstormer", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
  });
  const options = await reopen.list();
  assert.equal(options.length, 1);
  const outcome = await reopen.reopen(options[0]!.candidate);
  assert.equal(outcome.action, "reopened");

  const line = host.created[0]!.terminal.sent.at(-1) ?? "";
  assert.match(line, /--resume 4db0ed4c/);
  assert.match(line, /--add-dir/);
  assert.match(line, /--agent aboard-brainstormer-7/);

  // The fleet forgot this session when it ended, so it comes back as a fresh
  // record under the same identity — same agent id, same session id.
  const restored = fleet.get(agent("7"));
  assert.equal(restored?.sessionId, BRAINSTORM_SESSION);
  assert.equal(restored?.identity.type, "brainstormer");
  assert.deepEqual(restored?.resultDelivery, { mode: "none" });
  assert.equal(restored?.lifecycle.status, "running");
  // Nothing waits on it and it is the user's conversation: no result, no lease.
  assert.equal(host.created[0]!.options.env.ABOARD_ATTENDED, "1");
  assert.equal(lease.current(), undefined);
});

test("a session that ran in an auto-run's own checkout is reopened there, not in the workspace", async () => {
  const CHECKOUT = "C:\\sessions\\run_test\\repo";
  const resumeChecks: { sessionId: SessionId; cwd: string | undefined }[] = [];
  const ledger = recordEndedSession(undefined, {
    agentId: agent("11"),
    type: "implementer",
    sessionId: BRAINSTORM_SESSION,
    description: "address issue 34",
    endedAt: at("2026-07-30T09:30:00.000Z"),
    cwd: CHECKOUT,
    autoRunRestricted: true,
  });
  const { reopen, host } = setup({ ledger, resumeChecks });

  const options = await reopen.list();
  const outcome = await reopen.reopen(options[0]!.candidate);
  assert.equal(outcome.action, "reopened");

  assert.ok(resumeChecks.length > 0);
  assert.ok(resumeChecks.every((check) => check.cwd === CHECKOUT), JSON.stringify(resumeChecks));
  assert.equal(host.created[0]?.options.cwd, CHECKOUT);
  assert.match(host.created[0]!.terminal.sent.at(-1) ?? "", /Bash\(git commit\*\)/);
  assert.match(host.created[0]!.terminal.sent.at(-1) ?? "", /Bash\(gh pr merge\*\)/);
  // The visible `cd` matches, so the shell cannot start the session anywhere
  // else even if VS Code's own cwd handling is bypassed.
  assert.match(host.created[0]!.terminal.sent[0] ?? "", /sessions/);
});

test("an [AI]-chrome implementer is reopened with its recorded launch fact", async () => {
  const { reopen, host } = setup({
    ledger: {
      version: 1,
      sessions: [{
        agentId: agent("9"),
        type: "implementer",
        sessionId: GENERAL_SESSION,
        description: "address issue 34",
        endedAt: at("2026-07-30T09:30:00.000Z"),
        chromeEnabled: true,
      }],
    },
  });
  const outcome = await reopen.reopenLatest();
  assert.equal(outcome.action, "reopened");
  const line = host.created[0]!.terminal.sent.at(-1) ?? "";
  assert.match(line, /--resume af817a6c/);
  assert.match(line, /--chrome/);
  assert.match(line, /--agent aboard-implementer-9/);
});

test("a live session is focused rather than relaunched", async () => {
  const { reopen, fleet, openTerminals, liveTerminals, shown, host } = setup();
  fleet.register({
    identity: { agentId: agent("4"), type: "brainstormer" },
    sessionId: BRAINSTORM_SESSION,
    terminal: { terminalId: terminalId("live-terminal"), name: "aboard: plan for offline sync" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
    resultDelivery: { mode: "none" },
    telemetry,
  }, at("2026-07-30T10:00:00.000Z"));
  fleet.transition(agent("4"), { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") }, at("2026-07-30T10:00:00.000Z"));
  openTerminals.add("live-terminal");
  liveTerminals.set(agent("4"), terminalId("live-terminal"));

  const options = await reopen.list();
  assert.deepEqual(options.map((option) => option.candidate.origin), ["live"]);
  const outcome = await reopen.reopen(options[0]!.candidate);
  assert.equal(outcome.action, "focused");
  assert.deepEqual(shown, ["live-terminal"]);
  assert.equal(host.created.length, 0);
});

test("a pick made stale while the picker was open focuses the session instead of launching a second terminal", async () => {
  const { reopen, liveTerminals, shown, host } = setup({
    ledger: ledgerWith({ agentId: "7", type: "brainstormer", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
  });
  const options = await reopen.list();
  assert.equal(options[0]!.candidate.origin, "ended");

  // The user sat on the QuickPick, and the session came back to life meanwhile.
  // Relaunching would be refused downstream — one live terminal per agent.
  liveTerminals.set(agent("7"), terminalId("came-back"));
  const outcome = await reopen.reopen(options[0]!.candidate);
  assert.equal(outcome.action, "focused");
  assert.deepEqual(shown, ["came-back"]);
  assert.equal(host.created.length, 0);
});

test("a swept transcript is listed with its reason rather than dropped, and refuses to reopen", async () => {
  const { reopen, host } = setup({
    ledger: ledgerWith({ agentId: "7", type: "brainstormer", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
    resumable: () => false,
  });
  const options = await reopen.list();
  assert.equal(options.length, 1);
  assert.equal(options[0]!.resumable, false);
  assert.equal(options[0]!.reason, "no-transcript");

  const outcome = await reopen.reopen(options[0]!.candidate);
  assert.equal(outcome.action, "unresumable");
  assert.equal(host.created.length, 0);
  assert.equal(describeReopenOutcome(outcome), "Claude Code no longer has the conversation for agent 7, so it cannot be reopened.");
});

test("/reopen resolves to one session: the newest, or the newest matching a type or agent id", async () => {
  const { reopen, host } = setup({
    ledger: ledgerWith(
      { agentId: "5", type: "brainstormer", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:00:00.000Z" },
      { agentId: "6", type: "general-purpose", sessionId: GENERAL_SESSION, endedAt: "2026-07-30T11:00:00.000Z" },
    ),
  });
  const newest = await reopen.reopenLatest();
  assert.equal(newest.action === "reopened" ? newest.candidate.agentId : "", "6");

  // `/brainstorm` is the command the user types, `brainstormer` the type they
  // see in the tree; both name the same session.
  const byType = await reopen.reopenLatest("brainstorm");
  assert.equal(byType.action === "reopened" ? byType.candidate.agentId : "", "5");

  // Agent 6 is running again after the first call, so asking for it by id
  // focuses that terminal instead of launching a second one for the same agent.
  const byId = await reopen.reopenLatest("6");
  assert.equal(byId.action, "focused");

  const missing = await reopen.reopenLatest("webresearcher");
  assert.equal(missing.action, "none");
  assert.equal(missing.action === "none" ? missing.reason : "", "no-match");
  assert.equal(host.created.length, 2);
});

test("/reopen with nothing recorded launches nothing and says so", async () => {
  const { reopen, host } = setup();
  const outcome = await reopen.reopenLatest();
  assert.equal(outcome.action, "none");
  assert.equal(outcome.action === "none" ? outcome.reason : "", "no-recorded-sessions");
  assert.equal(host.created.length, 0);
  assert.match(describeReopenOutcome(outcome), /no recorded sessions/);
});

test("the picker names each row the way its session and fleet row are named", () => {
  const items = renderReopenItems([
    {
      candidate: { agentId: agent("7"), type: "brainstormer", sessionId: BRAINSTORM_SESSION, description: "plan for offline sync", origin: "ended", at: at("2026-07-30T08:00:00.000Z"), issueNumbers: [19] },
      resumable: true,
    },
    {
      candidate: { agentId: agent("9"), type: "general-purpose", sessionId: GENERAL_SESSION, description: "general purpose", origin: "ended", at: at("2026-07-30T09:30:00.000Z") },
      resumable: false,
      reason: "no-transcript",
    },
  ], new Date("2026-07-30T10:00:00.000Z"));

  assert.deepEqual(items.map((item) => item.label), ["aboard-brainstormer-7", "aboard-general-purpose-9"]);
  assert.equal(items[0]?.description, "plan for offline sync · issue #19");
  assert.match(items[0]?.detail ?? "", /Ended 2h ago/);
  // A session Claude Code can no longer resume says why, rather than quietly
  // disappearing from a list the user expects it in.
  assert.match(items[1]?.detail ?? "", /Cannot be reopened/);
});

test("reopening the Manager resumes it through its own path, never the generic launcher", async () => {
  const managerResumes: string[] = [];
  const { reopen, host } = setup({
    ledger: ledgerWith({ agentId: "1", type: "manager", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
    managerResumes,
  });

  const options = await reopen.list();
  const manager = options.find((option) => option.candidate.type === "manager");
  assert.ok(manager, "the recorded Manager appears among the sessions that can be reopened");

  const outcome = await reopen.reopen(manager.candidate);
  assert.equal(outcome.action, "reopened");
  // The Manager's own lifecycle ran; no generic terminal was created for it.
  assert.deepEqual(managerResumes, ["resumed"]);
  assert.equal(host.created.length, 0);
});

test("a live Manager is focused, not resumed a second time", async () => {
  const managerResumes: string[] = [];
  const { reopen, liveTerminals } = setup({
    ledger: ledgerWith({ agentId: "1", type: "manager", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
    managerResumes,
  });
  liveTerminals.set(agent("1"), terminalId("manager-terminal"));

  const options = await reopen.list();
  const manager = options.find((option) => option.candidate.type === "manager")!;
  const outcome = await reopen.reopen(manager.candidate);
  assert.equal(outcome.action, "focused");
  assert.deepEqual(managerResumes, []);
});

test("/reopen never reopens the Manager, even when it is the only recorded session", async () => {
  const managerResumes: string[] = [];
  const { reopen } = setup({
    ledger: ledgerWith({ agentId: "1", type: "manager", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
    managerResumes,
  });
  // The Manager drives /reopen through its MCP tool to reopen workers it handed
  // off; it can never reopen itself this way.
  const outcome = await reopen.reopenLatest();
  assert.equal(outcome.action, "none");
  assert.equal(outcome.action === "none" ? outcome.reason : "", "no-recorded-sessions");
  assert.deepEqual(managerResumes, []);
});

test("the picker pins the Manager above every other session", () => {
  const items = renderReopenItems([
    {
      candidate: { agentId: agent("9"), type: "general-purpose", sessionId: GENERAL_SESSION, description: "general purpose", origin: "ended", at: at("2026-07-30T09:30:00.000Z") },
      resumable: true,
    },
    {
      candidate: { agentId: agent("1"), type: "manager", sessionId: BRAINSTORM_SESSION, description: "Manager", origin: "ended", at: at("2026-07-30T08:00:00.000Z") },
      resumable: true,
    },
    {
      candidate: { agentId: agent("7"), type: "brainstormer", sessionId: BRAINSTORM_SESSION, description: "plan", origin: "ended", at: at("2026-07-30T09:00:00.000Z") },
      resumable: true,
    },
  ], new Date("2026-07-30T10:00:00.000Z"));

  // The Manager leads even though it is the oldest; the rest keep recency order.
  assert.deepEqual(items.map((item) => item.label), ["aboard-manager-1", "aboard-general-purpose-9", "aboard-brainstormer-7"]);
});

test("the command refuses an unresumable pick, and reopens a resumable one", async () => {
  const { reopen, host } = setup({
    ledger: ledgerWith({ agentId: "7", type: "brainstormer", sessionId: BRAINSTORM_SESSION, endedAt: "2026-07-30T09:30:00.000Z" }),
  });
  const messages: string[] = [];
  let picked: ReopenQuickPickItem | undefined;
  const registration = registerReopenCommand({
    registerCommand: (_command, callback) => ({ dispose: () => {}, run: callback }) as never,
    pick: async (items) => { picked = items[0]; return picked; },
    info: (message) => messages.push(`info: ${message}`),
    warning: (message) => messages.push(`warning: ${message}`),
    error: (message) => messages.push(`error: ${message}`),
  }, reopen) as unknown as { run: () => Promise<void> };

  await registration.run();
  assert.equal(picked?.label, "aboard-brainstormer-7");
  assert.deepEqual(messages, []);
  assert.equal(host.created.length, 1);
});

test("/reopen is intercepted for the Manager and reported without waking it", async () => {
  const fleet = new FleetRegistry();
  const managerId = agent("manager-1");
  fleet.register({
    identity: { agentId: managerId, type: "manager" },
    sessionId: session("140b5c21-eb37-4147-b5cb-6a5ca2592146"),
    terminal: { terminalId: terminalId("manager-terminal"), name: "Manager" },
    lifecycle: { status: "starting", startedAt: at("2026-07-30T10:00:00.000Z") },
    resultDelivery: { mode: "none" },
    telemetry,
  }, at("2026-07-30T10:00:00.000Z"));
  fleet.transition(managerId, { status: "running", startedAt: at("2026-07-30T10:00:00.000Z") }, at("2026-07-30T10:00:00.000Z"));
  const selectors: (string | undefined)[] = [];
  const prompts = new ManagerPromptService(
    fleet,
    { spawnInteractive: async () => assert.fail("an extension action must not launch an agent") },
    () => new Date("2026-07-30T14:31:00.000Z"),
    {
      startAutoRun: async () => assert.fail("no auto-run"),
      reviewPullRequest: async () => assert.fail("no review"),
      reopenSession: async (selector) => {
        selectors.push(selector);
        return { action: "reopened", candidate: { agentId: agent("7"), type: "brainstormer", sessionId: BRAINSTORM_SESSION, description: "plan", origin: "ended", at: at("2026-07-30T09:00:00.000Z") } };
      },
    },
  );

  const bare = await prompts.handle(managerId, "/reopen");
  assert.equal(bare.intercepted, true);
  assert.match(String(bare.message), /Reopened the brainstormer session \(agent 7\)/);

  // Unlike `/auto`, the trailing text is a real parameter and is forwarded.
  const selected = await prompts.handle(managerId, "/reopen brainstorm");
  assert.equal(selected.intercepted, true);
  assert.deepEqual(selectors, [undefined, "brainstorm"]);

  // The Manager learns what happened in the next real prompt's drain.
  const drained = await prompts.handle(managerId, "what changed?");
  assert.match(String(drained.additionalContext), /you ran \/reopen: Reopened the brainstormer session/);
});
