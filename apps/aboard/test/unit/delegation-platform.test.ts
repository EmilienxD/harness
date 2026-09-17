import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DelegationCoordinator, type DelegationConfigurationSource } from "../../src/bridge/delegation.js";
import { ChatGptAgentPlatform } from "../../src/chatgpt/platform.js";
import type { ResolvedPrompt } from "../../src/platform/prompts.js";
import { TerminalController, type StartupProofTracker, type TerminalCreationOptions, type TerminalHandle, type TerminalHost } from "../../src/platform/terminals.js";
import type { AgentId, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import { WriteLease } from "../../src/domain/lease.js";
import type { AgentPlatform, ConfiguredLaunch, PlatformLaunchRequest } from "../../src/platform/agent-platform.js";

const resolved = (text: string): ResolvedPrompt => ({ text, sources: [] });

function configurationSource(get: (type: import("../../src/domain/contracts.js").AgentType) => Promise<ConfiguredLaunch>): DelegationConfigurationSource {
  return { get, getFor: async (_platform, type) => get(type) };
}

class FakeTerminal implements TerminalHandle {
  public readonly sent: string[] = [];
  public readonly processId = Promise.resolve(123);
  public readonly exitStatus = undefined;
  public sendText(text: string): void { this.sent.push(text); }
  public show(): void {}
  public dispose(): void {}
}

class FakeTerminalHost implements TerminalHost {
  public readonly terminals: FakeTerminal[] = [];
  public readonly options: TerminalCreationOptions[] = [];
  public createBackgroundProcess(options: TerminalCreationOptions): TerminalHandle {
    return this.createTerminal(options);
  }

  public createTerminal(options: TerminalCreationOptions): TerminalHandle {
    const terminal = new FakeTerminal();
    this.options.push(options);
    this.terminals.push(terminal);
    return terminal;
  }
  public onDidCloseTerminal(): { dispose(): void } { return { dispose: () => undefined }; }
}

test("shared delegation asks the selected platform for an executable launch plan", async () => {
  const opaqueSettings = { ownedBy: "adapter" };
  const planned: PlatformLaunchRequest[] = [];
  const preflighted: readonly string[][] = [];
  const mutablePreflighted = preflighted as string[][];
  let createdSessions = 0;
  const platform: AgentPlatform = {
    id: "claude",
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    capabilities: {
      sessionIdentity: "client-assigned",
      promptDelivery: ["none", "inline", "spilled"],
      lifecycle: ["start", "stop", "end"],
      models: ["test-model"],
      reasoningEfforts: ["test-effort"],
    },
    createSession: () => {
      createdSessions += 1;
      return { sessionId: "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId, binding: "bound" };
    },
    bindSession: (current, observed) => current.sessionId === observed ? observed : undefined,
    normalizeLifecycle: () => { throw new Error("not used"); },
    requireEnforceableRestrictions: () => undefined,
    planLaunch: (request) => {
      planned.push(request);
      return {
        platform: "claude",
        kind: "start",
        agentId: request.agentId,
        sessionId: request.sessionId,
        agentType: request.agentType,
        shell: request.shell,
        command: ["runtime-wrapper", "profile"],
        args: ["--start"],
        commandLine: "runtime-wrapper profile --start",
        writeCapability: "write-capable",
        requiresWriteLease: false,
        promptDelivery: "none",
        runtimeDirectory: "C:/runtime/agents/agent-1",
      };
    },
    planSessionResume: () => { throw new Error("not used"); },
    preflight: async (plan) => { mutablePreflighted.push([...plan.command]); },
    isResumable: async () => false,
  };
  const host = new FakeTerminalHost();
  const fleet = new FleetRegistry();
  const terminals = new TerminalController({
    host,
    shell: "powershell",
    environment: () => ({ port: 4823, token: "token", workspaceRoot: "C:\\work" }),
    terminalIdFactory: () => "terminal-1" as TerminalId,
  });
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:\\work",
    promptRoot: "C:\\Temp\\abd-K7M2Q1",
    fleet,
    lease: new WriteLease(),
    terminals,
    configurations: configurationSource(async () => ({ platform: "claude", settings: opaqueSettings })),
    platforms: new Map([["claude", platform]]),
    prompts: { resolve: async () => undefined },
    spills: { prepare: async () => undefined, write: async () => "unused" },
    shell: "powershell",
    agentIdFactory: () => "agent-1" as AgentId,
  });

  const launched = await coordinator.launchInteractive({ type: "interactive", description: "shell", harnessStateDirectory: "C:/isolated-state", harnessRuntimePath: "C:/installed-runtime" }, "user");

  assert.equal(planned.length, 1);
  assert.equal(createdSessions, 1);
  assert.equal(planned[0]?.configuration, opaqueSettings);
  assert.equal(planned[0]?.promptRoot, "C:\\Temp\\abd-K7M2Q1");
  assert.equal(planned[0]?.autoRunRestricted, undefined);
  assert.deepEqual(preflighted, [["runtime-wrapper", "profile"]]);
  assert.equal(host.terminals[0]?.sent.at(-1), "runtime-wrapper profile --start");
  assert.equal(launched.terminalId, "terminal-1");
  assert.equal(fleet.get("agent-1" as AgentId)?.platform, "claude");
  assert.equal(fleet.get("agent-1" as AgentId)?.sessionBinding, "bound");
  assert.equal(fleet.get("agent-1" as AgentId)?.executionMode, "interactive");
  assert.equal(host.options[0]?.env.HARNESS_STATE_DIR, "C:/isolated-state");
  assert.ok(host.options[0]?.env.PYTHONPATH?.startsWith("C:/installed-runtime"));
});

test("shared delegation does not report a runtime-assigned session until its actual id is bound", async () => {
  const provisional = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
  const actual = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;
  let resolveProof: ((value: unknown) => void) | undefined;
  const proofs: StartupProofTracker = {
    awaitStarted: () => new Promise((resolve) => { resolveProof = resolve; }),
    cancel: () => undefined,
  };
  const platform: AgentPlatform = {
    id: "chatgpt",
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    capabilities: { sessionIdentity: "runtime-assigned", promptDelivery: ["none"], lifecycle: ["start"], models: [], reasoningEfforts: [] },
    createSession: () => ({ sessionId: provisional, binding: "provisional" }),
    bindSession: (current, observed) => current.binding === "provisional" ? observed : current.sessionId === observed ? observed : undefined,
    normalizeLifecycle: () => { throw new Error("not used"); },
    requireEnforceableRestrictions: () => undefined,
    planLaunch: (request) => ({
      platform: "chatgpt", kind: "start", agentId: request.agentId, sessionId: request.sessionId, agentType: request.agentType,
      shell: request.shell, command: ["codex"], args: [], commandLine: "codex", writeCapability: "write-capable",
      requiresWriteLease: false, promptDelivery: "none", runtimeDirectory: "C:/runtime/agents/agent-1",
    }),
    planSessionResume: () => { throw new Error("not used"); }, preflight: async () => undefined, isResumable: async () => false,
  };
  const host = new FakeTerminalHost();
  const fleet = new FleetRegistry();
  const terminals = new TerminalController({
    host, shell: "powershell", environment: () => ({ port: 4823, token: "token", workspaceRoot: "C:\\work" }),
    terminalIdFactory: () => "terminal-1" as TerminalId, startupProofs: proofs,
  });
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:\\work", fleet, lease: new WriteLease(), terminals,
    configurations: configurationSource(async () => ({ platform: "chatgpt", settings: { shape: "default" } })),
    platforms: new Map([["chatgpt", platform]]), prompts: { resolve: async () => undefined },
    spills: { prepare: async () => undefined, write: async () => "unused" }, shell: "powershell",
    agentIdFactory: () => "agent-1" as AgentId, startupTimeoutMs: 60_000,
  });

  let settled = false;
  const launched = coordinator.launchInteractive({ type: "interactive", description: "ChatGPT" }, "user").then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fleet.get("agent-1" as AgentId)?.lifecycle.status, "starting");
  terminals.bindSession("agent-1" as AgentId, provisional, actual);
  assert.equal(fleet.bindSession("agent-1" as AgentId, provisional, actual, new Date().toISOString() as IsoTimestamp), true);
  resolveProof?.({ agentId: "agent-1", sessionId: actual });

  assert.equal((await launched).sessionId, actual);
  assert.equal(fleet.get("agent-1" as AgentId)?.lifecycle.status, "running");
});

test("an auto-run ChatGPT Explore runs read-only and reports through the shared completion contract", async () => {
  const agentId = "agent-1" as AgentId;
  const delivered: string[] = [];
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId,
    policyProbe: { require: async () => undefined },
  });
  const host = new FakeTerminalHost();
  const fleet = new FleetRegistry();
  const terminals = new TerminalController({
    host, shell: "powershell", environment: () => ({ port: 4823, token: "token", workspaceRoot: "C:/work" }),
    terminalIdFactory: () => "terminal-1" as TerminalId,
  });
  const lease = new WriteLease();
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:/work", fleet, lease, terminals,
    configurations: configurationSource(async () => ({ platform: "chatgpt", settings: { shape: "explore", declaredCommand: ["codex"] } })),
    platforms: new Map([["chatgpt", platform]]),
    prompts: { resolve: async () => resolved("Explore the codebase without modifying files.\n\nReport the implementation context for issue #14.") },
    spills: { prepare: async () => undefined, write: async (file) => { delivered.push(file.contents); return file.relativePath; } }, shell: "powershell",
    agentIdFactory: () => agentId, runtimeDirectory: "C:/runtime",
  });

  const run = coordinator.runAutomated({ type: "Explore", description: "explore issue 14", issues: [14] });
  while (fleet.get(agentId) === undefined) await new Promise((resolve) => setImmediate(resolve));
  const command = host.terminals[0]?.sent.at(-1) ?? "";
  assert.match(command, /--sandbox read-only/u);
  assert.match(command, /approval_policy="never"/u);
  assert.match(delivered.at(-1) ?? "", /^Explore the codebase without modifying files\./u);
  assert.match(delivered.at(-1) ?? "", /Report the implementation context for issue #14\./u);
  assert.equal(lease.current(), undefined);

  coordinator.complete(agentId, {
    outcome: "succeeded", exitCode: 0, lastAssistantMessage: "Relevant files: src/chatgpt/launch.ts.",
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  });
  const outcome = await run;

  assert.equal(outcome.result.outcome, "succeeded");
  assert.equal(outcome.result.outcome === "succeeded" ? outcome.result.lastAssistantMessage : undefined, "Relevant files: src/chatgpt/launch.ts.");
  assert.equal(fleet.get(agentId)?.lifecycle.status, "completed");
});

test("an auto-run ChatGPT address invokes the address skill under the run's write lease and restrictions", async () => {
  const agentId = "agent-1" as AgentId;
  const sessionId = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
  const delivered: string[] = [];
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => sessionId,
    policyProbe: { require: async () => undefined },
    browserProbe: { require: async () => undefined },
  });
  const host = new FakeTerminalHost();
  const fleet = new FleetRegistry();
  const terminals = new TerminalController({
    host, shell: "powershell", environment: () => ({ port: 4823, token: "token", workspaceRoot: "C:/work" }),
    terminalIdFactory: () => "terminal-1" as TerminalId,
  });
  const lease = new WriteLease();
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:/work", fleet, lease, terminals,
    configurations: configurationSource(async () => ({
      platform: "chatgpt",
      settings: { shape: "skill", skillName: "address-this", declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "live", subagents: "allowed" },
    })),
    platforms: new Map([["chatgpt", platform]]),
    prompts: { resolve: async () => resolved("The checked-out branch is for issue #15.") },
    spills: { prepare: async () => undefined, write: async (file) => { delivered.push(file.contents); return file.relativePath; } },
    shell: "powershell", agentIdFactory: () => agentId, runtimeDirectory: "C:/runtime",
  });

  const run = coordinator.runAutomated({
    type: "address",
    description: "address issue 15",
    issues: [15],
    difficulty: "expert",
    chrome: true,
    isolation: {
      cwd: "C:\\checkouts\\run-1\\work",
      protectedPaths: ["C:/work"],
      writableRoots: ["C:\\work\\.git\\worktrees\\work", "C:\\work\\.git\\objects"],
    },
  });
  while (fleet.get(agentId) === undefined) await new Promise((resolve) => setImmediate(resolve));
  const command = host.terminals[0]?.sent.at(-1) ?? "";
  assert.match(command, /\$address-this/u);
  assert.match(command, /web_search="disabled"/u);
  assert.match(command, /features\.multi_agent=false/u);
  assert.match(command, /--model gpt-5\.6/u);
  assert.match(command, /model_reasoning_effort="high"/u);
  assert.match(command, /default_permissions="aboard-worktree"/u);
  assert.match(command, /permissions\.aboard-worktree=/u);
  assert.match(command, /workspace_roots=/u);
  assert.match(command, /approval_policy="never"/u);
  assert.match(command, /C:\\\\work\/\*\*/u);
  assert.equal(command.includes("The checked-out branch is for issue #15."), true);
  assert.equal(lease.current()?.agentId, agentId);
  assert.equal(fleet.get(agentId)?.chromeEnabled, true);
  assert.equal(fleet.get(agentId)?.autoRunRestricted, true);
  assert.equal(fleet.get(agentId)?.executionMode, "auto-run");

  coordinator.complete(agentId, {
    outcome: "succeeded", exitCode: 0, lastAssistantMessage: "Implemented issue #15.",
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  });

  assert.equal((await run).result.outcome, "succeeded");
  assert.equal(lease.current(), undefined);
});

test("an auto-run ChatGPT review invokes the review skill its mode selects and settles through the shared contract", async () => {
  const agentId = "agent-1" as AgentId;
  const sessionId = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
  const requested: (string | undefined)[] = [];
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => sessionId,
    policyProbe: { require: async () => undefined },
  });
  const host = new FakeTerminalHost();
  const fleet = new FleetRegistry();
  const terminals = new TerminalController({
    host, shell: "powershell", environment: () => ({ port: 4823, token: "token", workspaceRoot: "C:/work" }),
    terminalIdFactory: () => "terminal-1" as TerminalId,
  });
  const lease = new WriteLease();
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:/work", fleet, lease, terminals,
    configurations: configurationSource(async (type) => {
      requested.push(type);
      return {
        platform: "chatgpt",
        settings: { shape: "skill", skillName: "review-this", declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "live", subagents: "allowed" },
      };
    }),
    platforms: new Map([["chatgpt", platform]]),
    prompts: { resolve: async () => resolved("Review pull request #42 for issue #15.") },
    spills: { prepare: async () => undefined, write: async () => "unused" },
    shell: "powershell", agentIdFactory: () => agentId, runtimeDirectory: "C:/runtime",
  });

  const run = coordinator.runAutomated({ type: "review", description: "review pull request 42", issues: [15], pullRequest: 42, difficulty: "advanced" });
  while (fleet.get(agentId) === undefined) await new Promise((resolve) => setImmediate(resolve));
  const command = host.terminals[0]?.sent.at(-1) ?? "";
  assert.deepEqual(requested, ["review"]);
  assert.match(command, /\$review-this/u);
  assert.match(command, /web_search="disabled"/u);
  assert.equal(lease.current()?.agentId, agentId);
  assert.equal(fleet.get(agentId)?.autoRunRestricted, true);

  coordinator.complete(agentId, {
    outcome: "succeeded", exitCode: 0, lastAssistantMessage: "Requested changes: tighten the guard test.",
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  });
  const outcome = await run;

  assert.equal(outcome.result.outcome, "succeeded");
  assert.equal(outcome.result.outcome === "succeeded" ? outcome.result.lastAssistantMessage : undefined, "Requested changes: tighten the guard test.");
  assert.equal(fleet.get(agentId)?.lifecycle.status, "completed");
  assert.equal(lease.current(), undefined);
});

test("an explicitly interactive ChatGPT review remains attended", async () => {
  const agentId = "agent-1" as AgentId;
  const sessionId = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
  const requested: (string | undefined)[] = [];
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => sessionId,
    policyProbe: { require: async () => undefined },
  });
  const host = new FakeTerminalHost();
  const fleet = new FleetRegistry();
  const terminals = new TerminalController({
    host, shell: "powershell", environment: () => ({ port: 4823, token: "token", workspaceRoot: "C:/work" }),
    terminalIdFactory: () => "terminal-1" as TerminalId,
  });
  const lease = new WriteLease();
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:/work", fleet, lease, terminals,
    configurations: configurationSource(async (type) => {
      requested.push(type);
      return {
        platform: "chatgpt",
        settings: { shape: "skill", skillName: "review-this", declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "live", subagents: "allowed" },
      };
    }),
    platforms: new Map([["chatgpt", platform]]),
    prompts: { resolve: async () => resolved("Review pull request #42 for issue #15.") },
    spills: { prepare: async () => undefined, write: async () => "unused" },
    shell: "powershell", agentIdFactory: () => agentId, runtimeDirectory: "C:/runtime",
  });

  const handles = await coordinator.launchInteractive({ type: "review", description: "review pull request 42", issues: [15], pullRequest: 42 }, "auto-run");

  assert.deepEqual(requested, ["review"]);
  const command = host.terminals[0]?.sent.at(-1) ?? "";
  assert.match(command, /\$review-this/u);
  assert.match(command, /web_search="disabled"/u);
  assert.match(command, /features\.multi_agent=false/u);
  assert.equal(handles.sessionId, sessionId);
  const session = fleet.get(agentId);
  assert.equal(session?.attended, true);
  assert.deepEqual(session?.resultDelivery, { mode: "none" });
  assert.equal(session?.lifecycle.status, "running");
  // Explicitly interactive delegation keeps the lease and terminal until its
  // caller settles the session.
  assert.equal(lease.current()?.agentId, agentId);
});

test("a ChatGPT reopen uses ChatGPT configuration even when Claude is the Auto Run default", async () => {
  const sessionId = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;
  const agentId = "agent-1" as AgentId;
  let resolveProof: ((value: unknown) => void) | undefined;
  const proofs: StartupProofTracker = {
    awaitStarted: () => new Promise((resolve) => { resolveProof = resolve; }),
    cancel: () => undefined,
  };
  const platform: AgentPlatform = {
    id: "chatgpt",
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    capabilities: { sessionIdentity: "runtime-assigned", promptDelivery: ["none"], lifecycle: ["start"], models: [], reasoningEfforts: [] },
    createSession: () => ({ sessionId, binding: "provisional" }),
    bindSession: (current, observed) => current.sessionId === observed ? observed : undefined,
    normalizeLifecycle: () => { throw new Error("not used"); },
    requireEnforceableRestrictions: () => undefined,
    planLaunch: () => { throw new Error("not used"); },
    planSessionResume: (request) => ({
      platform: "chatgpt", kind: "resume", agentId: request.agentId, sessionId: request.sessionId, agentType: request.agentType,
      shell: request.shell, command: ["codex"], args: ["resume", sessionId], commandLine: `codex resume ${sessionId}`,
      writeCapability: "write-capable", requiresWriteLease: false, promptDelivery: "none", runtimeDirectory: "C:/runtime/agents/agent-1",
    }),
    preflight: async () => undefined,
    isResumable: async () => true,
  };
  const at = "2026-09-08T10:00:00.000Z" as IsoTimestamp;
  const fleet = new FleetRegistry();
  fleet.register({
    platform: "chatgpt", identity: { agentId, type: "interactive" }, sessionId, sessionBinding: "bound",
    terminal: { terminalId: "old-terminal" as TerminalId, name: "aboard: ChatGPT" }, lifecycle: { status: "starting", startedAt: at },
    resultDelivery: { mode: "none" }, attended: true,
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  }, at);
  fleet.transition(agentId, { status: "running", startedAt: at }, at);
  const lease = new WriteLease();
  lease.acquire("write-capable", { agentId, sessionId }, at, "existing owner");
  const host = new FakeTerminalHost();
  const terminals = new TerminalController({
    host, shell: "powershell", environment: () => ({ port: 4823, token: "token", workspaceRoot: "C:/work" }),
    terminalIdFactory: () => "new-terminal" as TerminalId, startupProofs: proofs,
  });
  const coordinator = new DelegationCoordinator({
    workspaceRoot: "C:/work", fleet, lease, terminals,
    configurations: {
      get: async () => ({ platform: "claude", settings: { shape: "default" } }),
      getFor: async (provider) => {
        assert.equal(provider, "chatgpt");
        return { platform: "chatgpt", settings: { shape: "default", declaredCommand: ["configured-codex"] } };
      },
    },
    platforms: new Map([["chatgpt", platform]]), prompts: { resolve: async () => undefined },
    spills: { prepare: async () => undefined, write: async () => "unused" }, shell: "powershell",
    agentIdFactory: () => "unused" as AgentId, startupTimeoutMs: 60_000,
  });

  let settled = false;
  const reopened = coordinator.reopen({
    platform: "chatgpt", agentId, type: "interactive", sessionId, terminalName: "aboard: ChatGPT", cwd: "C:/work",
  }).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fleet.get(agentId)?.lifecycle.status, "starting");
  assert.equal(fleet.get(agentId)?.sessionId, sessionId);
  assert.equal(lease.current()?.sessionId, sessionId);
  resolveProof?.({ agentId, sessionId });

  assert.equal((await reopened).terminalId, "new-terminal");
  assert.equal(fleet.get(agentId)?.lifecycle.status, "running");
  assert.equal(lease.current()?.sessionId, sessionId);
});

test("an isolated auto-run ChatGPT continuation reapplies the original checkout boundary", async () => {
  const agentId = "agent-1" as AgentId;
  const sessionId = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;
  const at = "2026-09-08T10:00:00.000Z" as IsoTimestamp;
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionProbe: { inspect: async () => ({ state: "resumable" }) },
    policyProbe: { require: async () => undefined },
  });
  const host = new FakeTerminalHost();
  const fleet = new FleetRegistry();
  const workspaceRoot = join(tmpdir(), "aboard-workspace");
  const worktreeRoot = join(tmpdir(), "aboard-worktree");
  const metadataRoots = [join(workspaceRoot, ".git", "worktrees", "work"), join(workspaceRoot, ".git", "objects")];
  fleet.register({
    platform: "chatgpt",
    identity: { agentId, type: "address" },
    sessionId,
    sessionBinding: "bound",
    terminal: { terminalId: "old-terminal" as TerminalId, name: "aboard: address issue 15" },
    lifecycle: { status: "starting", startedAt: at },
    resultDelivery: { mode: "tool-result" },
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
    issueNumbers: [15],
    cwd: worktreeRoot,
    autoRunRestricted: true,
  }, at);
  fleet.transition(agentId, { status: "running", startedAt: at }, at);
  fleet.transition(agentId, {
    status: "completed",
    startedAt: at,
    finishedAt: at,
    exitCode: 0,
    lastAssistantMessage: "The first attempt needs another turn.",
  }, at);
  const terminals = new TerminalController({
    host,
    shell: "powershell",
    environment: () => ({ port: 4823, token: "token", workspaceRoot }),
    terminalIdFactory: () => "new-terminal" as TerminalId,
  });
  const coordinator = new DelegationCoordinator({
    workspaceRoot,
    fleet,
    lease: new WriteLease(),
    terminals,
    configurations: configurationSource(async () => ({
      platform: "chatgpt",
      settings: { shape: "skill", skillName: "address-this", declaredCommand: ["codex"], webSearch: "live", subagents: "allowed" },
    })),
    platforms: new Map([["chatgpt", platform]]),
    prompts: { resolve: async () => undefined },
    spills: { prepare: async () => undefined, write: async () => "unused" },
    shell: "powershell",
    agentIdFactory: () => "unused" as AgentId,
    resolveWorktreeGitMetadataRoots: async () => metadataRoots,
  });

  const completionSha = "a".repeat(40);
  const reviewRange = `${"b".repeat(40)}..${"c".repeat(40)}`;
  const resumed = coordinator.resumeAutomated(fleet.get(agentId)!, "Continue addressing issue #15.", undefined, undefined, completionSha, reviewRange);
  while (host.terminals.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const command = host.terminals[0]?.sent.at(-1) ?? "";
  assert.match(command, /web_search="disabled"/u);
  assert.match(command, /features\.multi_agent=false/u);
  assert.match(command, /default_permissions="aboard-worktree"/u);
  const readOnlyRoot = process.platform === "win32" ? `${workspaceRoot.replaceAll("/", "\\")}/**` : `${workspaceRoot}/**`;
  assert.ok(command.includes(`${JSON.stringify(readOnlyRoot)}="read"`));
  assert.ok(command.includes(`${JSON.stringify(metadataRoots[0])}=true`));
  assert.equal(host.options[0]?.env?.ABOARD_WORKER_START_SHA, completionSha);
  assert.equal(host.options[0]?.env?.ABOARD_REVIEW_RANGE, reviewRange);
  assert.equal(host.options[0]?.env?.ABOARD_WORKER_CONTINUATION, "1");

  coordinator.complete(agentId, {
    outcome: "succeeded",
    exitCode: 0,
    lastAssistantMessage: "Implemented issue #15.",
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  });
  assert.equal((await resumed).result.outcome, "succeeded");
});
