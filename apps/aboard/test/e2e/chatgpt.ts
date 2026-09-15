import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  prepareCodexHome as prepareCoreCodexHome,
  validateCodexCli,
} from "../../../../tests/e2e/core/codex.js";

import { createPlatformLifecycleRoutes } from "../../src/bridge/platform-lifecycle.js";
import { startBridge } from "../../src/bridge/server.js";
import { SessionLifecycleService, SessionProcessMonitor, SessionStartupProofs, type ProcessEndedObservation } from "../../src/bridge/session-lifecycle.js";
import { FileSystemPromptSpillStore } from "../../src/platform/spill.js";
import { spawnCommandRunner } from "../../src/platform/preflight.js";
import { AUTO_RUN_RESTRICTIONS } from "../../src/auto/permissions.js";
import { ChatGptBrowserProbe } from "../../src/chatgpt/browser.js";
import { ChatGptAgentPlatform } from "../../src/chatgpt/platform.js";
import { ChatGptSessionProbe } from "../../src/chatgpt/sessions.js";
import type { AgentId, AgentSession, AgentType, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import { lockMarkerPresent, sessionWrapperLayout } from "../../src/runtime/lock-markers.js";
import type { HarnessConfig } from "./config.js";
import { contains } from "./config.js";
import { startFakeOpenAiServer } from "./codex-server.js";

const PROVISIONAL = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
const CODEX_COMMAND = ["codex", "exec", "--json"] as const;
const CODEX_MODEL = "codex-e2e";
const OPENAI_KEY_ENV = "ABOARD_E2E_OPENAI_KEY";
const execFileAsync = promisify(execFile);

export async function runChatGptSmoke(config: HarnessConfig): Promise<void> {
  const root = resolve(config.runtimeRoot, "chatgpt-smoke");
  if (!contains(config.runtimeRoot, root) || root === resolve(config.runtimeRoot)) throw new Error("ChatGPT smoke root escaped its dedicated runtime directory");
  await validateCodexCli();
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "sandbox-target.txt"), "sandbox baseline\n", "utf8");
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true });
  const diagnosticsPath = join(root, "responses-diagnostics.json");
  const server = await startFakeOpenAiServer({ diagnosticsPath });
  const home = await prepareCodexHome(root, server.baseUrl);
  const previousHome = process.env.CODEX_HOME;
  const previousKey = process.env[OPENAI_KEY_ENV];
  process.env.CODEX_HOME = home;
  process.env[OPENAI_KEY_ENV] = server.authToken;
  try {
    const attended = await runScenario(root, { prompt: "[E2E:chatgpt-success] complete the deterministic attended turn.", expectedExit: 0 });
    await runScenario(root, { prompt: "Continue", expectedExit: 0, resume: attended });
    await runScenario(root, { prompt: `${"large deterministic prompt ".repeat(300)}[E2E:chatgpt-process-failure]`, expectedExit: 1 });
    await runScenario(root, { prompt: "[E2E:chatgpt-explore] report the implementation context for this checkout.", expectedExit: 0, explore: true });
    const implementer = await runScenario(root, { prompt: "[E2E:chatgpt-implement] address the deterministic issue.", expectedExit: 0, implement: true });
    await runScenario(root, { prompt: "Continue", expectedExit: 0, implement: true, resume: implementer });
    await runScenario(root, { prompt: "[E2E:chatgpt-implement] address the deterministic issue with Chrome.", expectedExit: 0, implement: true, chrome: "declared" });
    await runChromeRefusal(root);
    await runScenario(root, { prompt: "[E2E:chatgpt-review-approve] review the deterministic pull request.", expectedExit: 0, review: "afk" });
    await runScenario(root, { prompt: "[E2E:chatgpt-review-changes] review the deterministic pull request.", expectedExit: 0, review: "afk" });
    await runScenario(root, { prompt: `${"large deterministic review ".repeat(300)}[E2E:chatgpt-process-failure]`, expectedExit: 1, review: "afk" });
    await runScenario(root, { prompt: "[E2E:chatgpt-review-approve] review the deterministic pull request with a human.", expectedExit: 0, review: "hitl" });
    const assertions = server.assertions();
    for (const checkpoint of ["prompt:spilled", "attended:tool", "attended:complete", "explore:tool", "explore:complete", "implement:guard", "implement:tool", "implement:complete", "review-approve:complete", "review-changes:complete", "process-failure:failed"]) {
      if (!assertions.checkpoints.includes(checkpoint)) throw new Error(`Codex Responses scenario did not reach ${checkpoint}`);
    }
    if (assertions.unexpectedRequests !== 0) throw new Error(`Codex made ${assertions.unexpectedRequests} structurally invalid Responses requests`);
    const diagnostics = await readFile(diagnosticsPath, "utf8");
    if (/chatgpt-success|chatgpt-implement|chatgpt-review|chatgpt-explore|aboard-e2e-/u.test(diagnostics)) throw new Error("Codex Responses diagnostics persisted prompt or credential material");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousKey === undefined) delete process.env[OPENAI_KEY_ENV]; else process.env[OPENAI_KEY_ENV] = previousKey;
    await server.close();
  }
}

interface Scenario {
  readonly prompt: string;
  readonly expectedExit: number;
  readonly resume?: SessionId;
  readonly explore?: boolean;
  readonly implement?: boolean;
  readonly review?: "afk" | "hitl";
  readonly chrome?: "declared" | "absent";
}

const LIFECYCLE_ASSETS = {
  settings: resolve(process.cwd(), "assets", "runtime", "abd-hooks.json"),
  script: resolve(process.cwd(), "assets", "runtime", "abd_hook.py"),
} as const;

function scenarioAgentType(scenario: Scenario): AgentType {
  if (scenario.explore === true) return "Explore";
  if (scenario.implement === true) return "implementer";
  return scenario.review === undefined ? "interactive" : "reviewer";
}

function scenarioConfiguration(scenario: Scenario, command: readonly string[]): Record<string, unknown> {
  if (scenario.implement === true) return { shape: "skill", skillName: "address-this", declaredCommand: command };
  if (scenario.review !== undefined) return { shape: "skill", skillName: "review-this", declaredCommand: command };
  return { shape: scenario.explore === true ? "explore" : "default", declaredCommand: command };
}

/** One runtime directory per session kind; a resume deliberately reuses its launch's. */
function scenarioName(scenario: Scenario): string {
  if (scenario.explore === true) return "explore";
  if (scenario.implement === true) return `implement-${scenario.chrome ?? "plain"}`;
  if (scenario.review !== undefined) return `review-${scenario.review}-${scenario.expectedExit}`;
  return `${scenario.expectedExit}`;
}

export async function prepareCodexHome(root: string, baseUrl: string, trustedProjects: readonly string[] = []): Promise<string> {
  const home = await prepareCoreCodexHome({ root, baseUrl, model: CODEX_MODEL, providerName: "aboard-e2e", envKey: OPENAI_KEY_ENV, trustedProjects });
  await writeSkill(home, "address-this", "[E2E:address-this-skill-loaded] Follow the supplied issue and finish with the exact model-provided result.");
  await writeSkill(home, "review-this", "[E2E:review-this-skill-loaded] Review the supplied change and finish with the exact model-provided disposition.");
  return home;
}

async function writeSkill(home: string, name: string, instruction: string): Promise<void> {
  const directory = join(home, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Deterministic Aboard E2E fixture.\n---\n\n${instruction}\n`, "utf8");
}

/** The deterministic final message each scenario's session reports on Stop. */
function expectedFinalMessage(scenario: Scenario): string {
  if (scenario.explore === true) return "Explore report: the deterministic checkout keeps its launch plan in src/chatgpt/launch.ts.";
  if (scenario.implement === true) return "Implemented the deterministic issue; the work is uncommitted.";
  if (scenario.review !== undefined) {
    return scenario.prompt.includes("[E2E:chatgpt-review-changes]")
      ? "Review complete: requested changes before this can merge."
      : "Review complete: the implementation matches the frozen issue contract.";
  }
  return "Deterministic ChatGPT session completed.";
}

/** A Codex configuration whose only relevant declaration is the browser backend list. */
async function codexHome(root: string, name: string, backends: string): Promise<string> {
  const home = join(root, `codex-${name}`);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), `[mcp_servers.deterministic-browser.env]\nBROWSER_USE_AVAILABLE_BACKENDS = "${backends}"\n`, "utf8");
  return home;
}

async function browserProbeFor(root: string, scenario: Scenario): Promise<{ readonly browserProbe: ChatGptBrowserProbe } | Record<string, never>> {
  if (scenario.chrome === undefined) return {};
  const home = await codexHome(root, scenario.chrome, scenario.chrome === "declared" ? " CDP , Chrome " : "builtin");
  return { browserProbe: new ChatGptBrowserProbe({ codexHome: home }) };
}

/** A Chrome-required launch must fail before any terminal or Codex process exists. */
async function runChromeRefusal(root: string): Promise<void> {
  const agentId = "chatgpt-chrome-absent" as AgentId;
  const runtimeRoot = join(root, agentId);
  const scenario: Scenario = { prompt: "[E2E:chatgpt-implement] address it.", expectedExit: 0, implement: true, chrome: "absent" };
  const platform = new ChatGptAgentPlatform({
    commandRunner: spawnCommandRunner(root),
    lifecycleAssets: LIFECYCLE_ASSETS,
    sessionIdFactory: () => PROVISIONAL,
    ...(await browserProbeFor(root, scenario)),
  });
  const plan = platform.planLaunch({
    agentId, sessionId: PROVISIONAL, agentType: "implementer", shell: process.platform === "win32" ? "powershell" : "git-bash",
    configuration: scenarioConfiguration(scenario, CODEX_COMMAND),
    prompt: scenario.prompt, runtimeDirectory: runtimeRoot, chrome: true,
  });
  if (plan.chromeRequired !== true) throw new Error("ChatGPT E2E lost the Chrome requirement on the launch plan");
  let refused: string | undefined;
  try { await platform.preflight(plan); } catch (error) { refused = error instanceof Error ? error.message : String(error); }
  if (refused === undefined) throw new Error("ChatGPT E2E started Chrome-required work without a declared Chrome backend");
  if (!/BROWSER_USE_AVAILABLE_BACKENDS/u.test(refused)) throw new Error(`ChatGPT E2E gave an unusable Chrome refusal: ${refused}`);
  if (existsSync(join(runtimeRoot, "agents", agentId, "guard.json"))) throw new Error("ChatGPT E2E prepared runtime files for a refused launch");
}

async function runScenario(root: string, scenario: Scenario): Promise<SessionId> {
  const { prompt, expectedExit, resume, explore = false, implement = false } = scenario;
  const agentType = scenarioAgentType(scenario);
  const worker = implement || scenario.review !== undefined;
  const agentId = `chatgpt-${scenarioName(scenario)}` as AgentId;
  const runtimeRoot = join(root, agentId);
  const wrapper = sessionWrapperLayout(runtimeRoot, resolve(process.cwd(), "assets", "runtime", "abd_wrapper.py"));
  const realSessionProbe = new ChatGptSessionProbe();
  const platform = new ChatGptAgentPlatform({
    commandRunner: spawnCommandRunner(root),
    lifecycleAssets: LIFECYCLE_ASSETS,
    sessionIdFactory: () => PROVISIONAL,
    sessionProbe: { inspect: (sessionId, cwd) => realSessionProbe.inspect(sessionId, cwd, ["codex"]) },
    ...(await browserProbeFor(root, scenario)),
  });
  const fleet = new FleetRegistry();
  const now = new Date().toISOString() as IsoTimestamp;
  const expectedSessionId = resume ?? PROVISIONAL;
  const session: AgentSession = {
    platform: "chatgpt", identity: { agentId, type: agentType }, sessionId: expectedSessionId, sessionBinding: resume === undefined ? "provisional" : "bound",
    terminal: { terminalId: `terminal-${agentId}` as TerminalId, name: "ChatGPT E2E" },
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
        canBindSession: (candidate, expected) => candidate === agentId && expected === expectedSessionId,
        bindSession: () => undefined,
      }],
    }),
  });
  try {
    const request = {
      agentId, sessionId: PROVISIONAL, agentType, shell: process.platform === "win32" ? "powershell" : "git-bash",
      configuration: scenarioConfiguration(scenario, CODEX_COMMAND), prompt,
      runtimeDirectory: runtimeRoot, maxInlinePromptChars: expectedExit === 0 ? 4000 : 20, wrapper,
      ...(worker ? { autoRunRestricted: true as const, restrictions: AUTO_RUN_RESTRICTIONS } : {}),
      ...(scenario.chrome === "declared" ? { chrome: true as const } : {}),
    } as const;
    const plan = resume === undefined
      ? platform.planLaunch(request)
      : platform.planSessionResume({ ...request, sessionId: resume })
    await platform.preflight(plan);
    if (resume !== undefined) {
      if (!await platform.isResumable(resume, root, plan.command)) throw new Error("ChatGPT E2E could not discover its saved session through the real Codex App Server");
      if (await platform.isResumable("c15badb6-d6c8-45a6-a59f-e931cd364332" as SessionId, root, plan.command)) {
        throw new Error("ChatGPT E2E treated a missing session as resumable");
      }
    }
    const files = new FileSystemPromptSpillStore(root, runtimeRoot, new Map([["chatgpt", platform.lifecycleAssets]]));
    await files.prepare(plan);
    if (plan.spill !== undefined) await files.write(plan.spill);
    if (worker) {
      if (!existsSync(join(runtimeRoot, "agents", agentId, "guard.json"))) throw new Error(`ChatGPT E2E launched a ${agentType} without its restriction list`);
      if ((plan.task === undefined) !== (resume !== undefined)) throw new Error("ChatGPT E2E did not archive the frozen task exactly once, at launch");
      if (!plan.args.includes('web_search="disabled"')) throw new Error(`ChatGPT E2E left web search enabled for a ${agentType}`);
      if (!plan.requiresWriteLease) throw new Error(`ChatGPT E2E left a ${agentType} outside the run's write lease`);
    }
    monitor.trackLaunch({ agentId, sessionId: expectedSessionId, lockFile: wrapper.lockPathFor(agentId) });
    const proof = proofs.awaitStarted(agentId, expectedSessionId, 10_000);
    if (plan.wrapperRequest === undefined) throw new Error("ChatGPT E2E expected wrapper request delivery");
    const execution = spawnCaptured("uv", ["run", "--no-project", "--no-managed-python", wrapper.script, wrapper.lockPathFor(agentId), "--request", plan.wrapperRequest.relativePath], root, {
      ...process.env,
      ABOARD_BRIDGE_PORT: String(bridge.port), ABOARD_BRIDGE_TOKEN: bridge.token,
      ABOARD_AGENT_ID: agentId, ABOARD_SESSION_ID: expectedSessionId, ABOARD_AGENT_TYPE: agentType,
      ABOARD_RUNTIME_ROOT: runtimeRoot, ABOARD_WORKSPACE_ROOT: root, ABOARD_ATTENDED: "1",
    });
    // A CLI that dies before its first observation leaves the proof to time
    // out; its captured output is the only account of why.
    let started: Awaited<typeof proof>;
    try {
      started = await proof;
    } catch (error) {
      const failed = await execution;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Child exited ${failed.code}; `
        + `stderr: ${redactProcessError(failed.stderr)}; output: ${redactProcessError(failed.stdout)}`,
      );
    }
    const actualSessionId = started.sessionId;
    if (resume === undefined && actualSessionId === PROVISIONAL) throw new Error("ChatGPT E2E did not bind the runtime-assigned Codex session id");
    if (resume !== undefined && actualSessionId !== resume) throw new Error("ChatGPT E2E resumed a different Codex session");
    if (fleet.get(agentId)?.sessionId !== actualSessionId) throw new Error("ChatGPT E2E did not preserve the runtime session id");
    fleet.transition(agentId, { status: "running", startedAt: now }, now);
    const result = await execution;
    if (result.code !== expectedExit) throw new Error(`ChatGPT E2E child exited ${result.code}; expected ${expectedExit}; stderr: ${redactProcessError(result.stderr)}; output: ${redactProcessError(result.stdout)}`);
    monitor.poll();
    if (ended.length !== 1 || ended[0]?.phase !== "live" || ended[0]?.sessionId !== actualSessionId) throw new Error("ChatGPT E2E did not observe the bound process ending");
    const final = fleet.get(agentId)?.lastObservedAssistantMessage;
    if (expectedExit === 0 && final !== expectedFinalMessage(scenario)) throw new Error(`ChatGPT E2E lost final assistant output: ${String(final)}`);
    if (expectedExit !== 0 && final !== undefined) throw new Error("ChatGPT E2E manufactured output for a failed process");
    const attempted = existsSync(join(root, `write-attempt-${scenarioArtifact(scenario)}.txt`));
    if (explore && await readFile(join(root, "sandbox-target.txt"), "utf8") !== "sandbox baseline\n") throw new Error("ChatGPT E2E Explore session modified the checkout");
    if (!explore && resume === undefined && expectedExit === 0 && !attempted) throw new Error("ChatGPT E2E never proved a write-capable session can execute a real Codex tool");
    return actualSessionId;
  } finally {
    sessions.dispose();
    monitor.stop();
    await bridge.stop();
  }
}

function scenarioArtifact(scenario: Scenario): string {
  if (scenario.implement === true) return "implement";
  if (scenario.review === "afk" && scenario.prompt.includes("review-changes")) return "review-changes";
  if (scenario.review !== undefined) return "review-approve";
  return "attended";
}

function spawnCaptured(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

export { validateCodexCli } from "../../../../tests/e2e/core/codex.js";

export function redactProcessError(captured: string): string {
  if (captured.length === 0) return "no output";
  const bytes = Buffer.byteLength(captured, "utf8");
  if (/resolves to the script shim[\s\S]*cannot receive this command line unchanged/iu.test(captured)) {
    return `unsupported Windows script shim (${bytes} bytes redacted)`;
  }
  return `${bytes} bytes redacted`;
}
