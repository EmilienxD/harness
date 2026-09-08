import assert from "node:assert/strict";
import test from "node:test";

import { DelegationCoordinator } from "../src/bridge/delegation.js";
import { TerminalController, type StartupProofTracker, type TerminalCreationOptions, type TerminalHandle, type TerminalHost } from "../src/claude/terminals.js";
import type { AgentId, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";
import type { AgentPlatform, PlatformLaunchRequest } from "../src/platform/agent-platform.js";

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
  public createTerminal(_options: TerminalCreationOptions): TerminalHandle {
    const terminal = new FakeTerminal();
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
    preflight: async (command) => { mutablePreflighted.push([...command]); },
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
    fleet,
    lease: new WriteLease(),
    terminals,
    configurations: { get: async () => ({ platform: "claude", settings: opaqueSettings }) },
    platforms: new Map([["claude", platform]]),
    prompts: { resolve: async () => undefined },
    spills: { prepare: async () => undefined, write: async () => "unused" },
    shell: "powershell",
    agentIdFactory: () => "agent-1" as AgentId,
  });

  const launched = await coordinator.launchInteractive({ type: "interactive", description: "shell" }, "user");

  assert.equal(planned.length, 1);
  assert.equal(createdSessions, 1);
  assert.equal(planned[0]?.configuration, opaqueSettings);
  assert.deepEqual(preflighted, [["runtime-wrapper", "profile"]]);
  assert.equal(host.terminals[0]?.sent.at(-1), "runtime-wrapper profile --start");
  assert.equal(launched.terminalId, "terminal-1");
  assert.equal(fleet.get("agent-1" as AgentId)?.platform, "claude");
  assert.equal(fleet.get("agent-1" as AgentId)?.sessionBinding, "bound");
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
    configurations: { get: async () => ({ platform: "chatgpt", settings: { shape: "default" } }) },
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

test("a ChatGPT reopen preserves identity and ownership while waiting for resume startup proof", async () => {
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
    configurations: { get: async () => ({ platform: "chatgpt", settings: { shape: "default" } }) },
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
