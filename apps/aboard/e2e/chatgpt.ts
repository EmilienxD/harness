import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createPlatformLifecycleRoutes } from "../src/bridge/platform-lifecycle.js";
import { startBridge } from "../src/bridge/server.js";
import { SessionLifecycleService, SessionProcessMonitor, SessionStartupProofs, type ProcessEndedObservation } from "../src/bridge/session-lifecycle.js";
import { FileSystemPromptSpillStore } from "../src/claude/spill.js";
import { spawnCommandRunner } from "../src/claude/preflight.js";
import { ChatGptAgentPlatform } from "../src/chatgpt/platform.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { lockMarkerPresent, sessionWrapperLayout } from "../src/runtime/lock-markers.js";
import type { HarnessConfig } from "./config.js";
import { contains } from "./config.js";

const PROVISIONAL = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
const ACTUAL = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;

export async function runChatGptSmoke(config: HarnessConfig): Promise<void> {
  const root = resolve(config.runtimeRoot, "chatgpt-smoke");
  if (!contains(config.runtimeRoot, root) || root === resolve(config.runtimeRoot)) throw new Error("ChatGPT smoke root escaped its dedicated runtime directory");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    await runScenario(root, "[E2E:chatgpt-success] complete the deterministic attended turn.", 0);
    await runScenario(root, `${"large deterministic prompt ".repeat(300)}[E2E:chatgpt-process-failure]`, 23);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runScenario(root: string, prompt: string, expectedExit: number): Promise<void> {
  const agentId = `chatgpt-${expectedExit}` as AgentId;
  const runtimeRoot = join(root, agentId);
  const wrapper = sessionWrapperLayout(runtimeRoot, resolve(process.cwd(), "assets", "runtime", "abd_wrapper.py"));
  const platform = new ChatGptAgentPlatform({
    commandRunner: spawnCommandRunner(root),
    lifecycleAssets: {
      settings: resolve(process.cwd(), "assets", "runtime", "abd-hooks.json"),
      script: resolve(process.cwd(), "assets", "runtime", "abd_hook.py"),
    },
    sessionIdFactory: () => PROVISIONAL,
  });
  const fleet = new FleetRegistry();
  const now = new Date().toISOString() as IsoTimestamp;
  const session: AgentSession = {
    platform: "chatgpt", identity: { agentId, type: "interactive" }, sessionId: PROVISIONAL, sessionBinding: "provisional",
    terminal: { terminalId: `terminal-${expectedExit}` as TerminalId, name: "ChatGPT E2E" },
    lifecycle: { status: "starting", startedAt: now }, resultDelivery: { mode: "none" }, attended: true,
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  };
  fleet.register(session, now);
  const ended: ProcessEndedObservation[] = [];
  const monitor = new SessionProcessMonitor({ probe: lockMarkerPresent, onProcessEnded: (event) => ended.push(event) });
  const proofs = new SessionStartupProofs();
  const sessions = new SessionLifecycleService({ fleet, monitor, settlement: { settleConversationEnded: () => undefined }, lockPathFor: wrapper.lockPathFor });
  const bridge = await startBridge({
    preferredPort: 0,
    handler: createPlatformLifecycleRoutes({
      fleet, platforms: new Map([["chatgpt", platform]]), sessions,
      workers: { stop: async () => false, failure: async () => false },
      compactions: { compact: () => undefined }, proofs,
      sessionBindings: [{
        canBindSession: (candidate, expected) => candidate === agentId && expected === PROVISIONAL,
        bindSession: () => undefined,
      }],
    }),
  });
  try {
    const fakeCodex = resolve(process.cwd(), "e2e", "fake-codex.mjs");
    const plan = platform.planLaunch({
      agentId, sessionId: PROVISIONAL, agentType: "interactive", shell: process.platform === "win32" ? "powershell" : "git-bash",
      configuration: { shape: "default", declaredCommand: [process.execPath, fakeCodex] }, prompt,
      runtimeDirectory: runtimeRoot, maxInlinePromptChars: expectedExit === 0 ? 4000 : 20, wrapper,
    });
    await platform.preflight(plan.command);
    const files = new FileSystemPromptSpillStore(root, runtimeRoot, new Map([["chatgpt", platform.lifecycleAssets]]));
    await files.prepare(plan);
    if (plan.spill !== undefined) await files.write(plan.spill);
    monitor.trackLaunch({ agentId, sessionId: PROVISIONAL, lockFile: wrapper.lockPathFor(agentId) });
    const proof = proofs.awaitStarted(agentId, PROVISIONAL, 10_000);
    if (plan.wrapperRequest === undefined) throw new Error("ChatGPT E2E expected wrapper request delivery");
    const execution = spawnCaptured("uv", ["run", "--no-project", "--no-managed-python", wrapper.script, wrapper.lockPathFor(agentId), "--request", plan.wrapperRequest.relativePath], root, {
      ...process.env,
      ABOARD_BRIDGE_PORT: String(bridge.port), ABOARD_BRIDGE_TOKEN: bridge.token,
      ABOARD_AGENT_ID: agentId, ABOARD_SESSION_ID: PROVISIONAL, ABOARD_AGENT_TYPE: "interactive",
      ABOARD_RUNTIME_ROOT: runtimeRoot, ABOARD_WORKSPACE_ROOT: root, ABOARD_ATTENDED: "1",
    });
    const started = await proof;
    if (started.sessionId !== ACTUAL || fleet.get(agentId)?.sessionId !== ACTUAL) throw new Error("ChatGPT E2E did not bind the runtime session id");
    fleet.transition(agentId, { status: "running", startedAt: now }, now);
    const result = await execution;
    if (result !== expectedExit) throw new Error(`ChatGPT E2E child exited ${result}; expected ${expectedExit}`);
    monitor.poll();
    if (ended.length !== 1 || ended[0]?.phase !== "live" || ended[0]?.sessionId !== ACTUAL) throw new Error("ChatGPT E2E did not observe the bound process ending");
    const final = fleet.get(agentId)?.lastObservedAssistantMessage;
    if (expectedExit === 0 && final !== "Deterministic ChatGPT session completed.") throw new Error("ChatGPT E2E lost final assistant output");
    if (expectedExit !== 0 && final !== undefined) throw new Error("ChatGPT E2E manufactured output for a failed process");
  } finally {
    sessions.dispose();
    monitor.stop();
    await bridge.stop();
  }
}

function spawnCaptured(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], { cwd, env, shell: false, windowsHide: true, stdio: "ignore" });
    const timeout = setTimeout(() => child.kill(), 15_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolvePromise(code); });
  });
}
