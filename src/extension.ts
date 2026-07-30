import type { ExtensionContext } from "vscode";
import { commands, window, workspace } from "vscode";
import { randomUUID } from "node:crypto";

import {
  FileBridgeDiscoveryPersistence,
} from "./bridge/discovery.js";
import {
  DEFAULT_BRIDGE_PORT,
  startBridge,
  type BridgeRuntime,
} from "./bridge/server.js";
import { createTerminalRoutes } from "./bridge/terminal-routes.js";
import { TerminalController } from "./claude/terminals.js";
import type { TerminalId } from "./domain/contracts.js";
import { createVsCodeTerminalHost } from "./vscode/terminals.js";
import { FileManagerStore, ManagerLifecycle } from "./claude/manager.js";
import type { WorkerPermissionMode } from "./claude/launch.js";
import { GitHubBoundaryError, GitHubClient, ProcessGhExecutor } from "./github/client.js";
import { scaffoldProject } from "./scaffold/project.js";
import { join } from "node:path";
import { FleetRegistry } from "./domain/fleet.js";
import { WriteLease } from "./domain/lease.js";
import { registerNativeFleetUi } from "./vscode/native-ui.js";
import { readAboardConfiguration, MANAGER_RESTART_SETTINGS } from "./configuration.js";
import { FileFleetStore, PersistOnChange } from "./runtime/persistence.js";
import { combineHandlers } from "./bridge/router.js";
import { DelegationCoordinator, type DelegationConfigurationSource } from "./bridge/delegation.js";
import { createMcpHandler } from "./bridge/mcp.js";
import { WorkerHookService, createWorkerHookRoutes } from "./bridge/worker-hooks.js";
import {
  ManagerBriefings,
  ManagerPromptService,
  ManagerStopService,
  createManagerHookRoutes,
  type BriefingSlice,
  type BriefingSources,
} from "./bridge/manager-hooks.js";
import { GitWorkingTreeInspector, WorkerLifecycleReconciler, createWorkerLifecycleRoutes } from "./bridge/lifecycle.js";
import { PromptResolver } from "./claude/prompts.js";
import { GitHubDelegationPromptResolver } from "./github/prompt-adapter.js";
import { FileSystemPromptSpillStore } from "./claude/spill.js";
import { parseAgentDefinition } from "./scaffold/agent-definition.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentId, AgentSession, IsoTimestamp, SessionId } from "./domain/contracts.js";
import { ReviewCoordinator } from "./github/review.js";
import { registerReviewCommand } from "./vscode/review.js";

let bridge: BridgeRuntime | undefined;
let persistence: PersistOnChange | undefined;

function configuration() {
  return readAboardConfiguration({ get: (section) => workspace.getConfiguration().get(section) });
}

/**
 * Briefing sources for the Manager's split SessionStart hooks. Each slice is
 * independently fallible by design: `ManagerBriefings` converts a rejection into
 * a one-line "unavailable" note, so one broken `gh` call degrades a single slice
 * instead of losing the whole briefing.
 */
function briefingSources(workspaceRoot: string, github: GitHubClient, previousSessionAt: () => string | undefined): BriefingSources {
  const git = async (args: readonly string[]): Promise<string> =>
    (await promisify(execFile)("git", [...args], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true })).stdout.trim();
  return {
    git: async () => ({
      branch: await git(["branch", "--show-current"]) || "detached",
      head: await git(["rev-parse", "--short", "HEAD"]),
      dirty: (await git(["status", "--porcelain"])).length > 0,
    }),
    github: async () => {
      const roadmap = await github.listRoadmapIssues();
      const since = previousSessionAt();
      const merges = since === undefined ? [] : await github.listUnreviewedMerges(since);
      const open = roadmap.filter((issue) => issue.disposition === "hitl");
      return {
        readyIssues: roadmap.filter((issue) => issue.ready).map((issue) => issue.number),
        openPullRequests: [],
        hitlIssues: open.map((issue) => issue.number),
        unreviewedMergeCount: merges.length,
      };
    },
    todoIssue: async () => {
      try { return (await github.getTodo()).number; }
      catch (error) { if (error instanceof GitHubBoundaryError && error.code === "missing-todo") return undefined; throw error; }
    },
  };
}

function workerConfigurations(workspaceRoot: string): DelegationConfigurationSource {
  return { get: async (type) => {
    if (type === "raw") return { shape: "inline" };
    const result = parseAgentDefinition(await readFile(join(workspaceRoot, ".claude", "agents", `${type}.md`), "utf8"));
    if (!result.ok) throw new Error(`Invalid ${type} agent definition: ${result.reason}`);
    return { shape: "agent-defined", agentName: type, declaredTools: result.value.tools };
  } };
}

export async function activate(context: ExtensionContext): Promise<void> {
  if ((workspace.workspaceFolders?.length ?? 0) > 1) { void window.showErrorMessage("aboard v1 supports exactly one workspace folder. Open the project in a single-root window."); return; }
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot === undefined) return;

  const output = window.createOutputChannel("aboard");
  context.subscriptions.push(output);
  const initialConfiguration = configuration();
  for (const diagnostic of initialConfiguration.diagnostics) output.appendLine(`Configuration: ${diagnostic.message}`);
  if (initialConfiguration.diagnostics.length > 0) void window.showWarningMessage(initialConfiguration.diagnostics.map((item) => item.message).join(" "));
  let currentConfiguration = initialConfiguration.value;
  let bridgeEnvironment: { port: number; token: string } | undefined;
  let lifecycle: WorkerLifecycleReconciler | undefined;
  const terminals = new TerminalController({
    host: createVsCodeTerminalHost(),
    environment: () => {
      if (bridgeEnvironment === undefined) throw new Error("Bridge is not ready");
      return { ...bridgeEnvironment, workspaceRoot };
    },
    terminalIdFactory: () => randomUUID() as TerminalId,
    onLifecycleEvent: (event) => {
      if (event.type === "terminal-closed") {
        output.appendLine(`Terminal ${event.terminalId} closed (${event.reason}, exit ${event.exitCode ?? "unknown"})`);
      }
      if (event.type === "terminal-closed" && fleet?.get(event.agentId)?.identity.type !== "manager") void lifecycle?.terminalClosed(event).catch((error: unknown) => output.appendLine(`Lifecycle reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`));
    },
  });
  context.subscriptions.push({ dispose: () => terminals.dispose() });
  const fleetStore = new FileFleetStore(workspaceRoot);
  const persistedFleet = await fleetStore.load();
  const fleet = persistedFleet === undefined ? new FleetRegistry() : FleetRegistry.restore(persistedFleet);
  const lease = new WriteLease();
  const managerStore = new FileManagerStore(workspaceRoot);
  const github = new GitHubClient(new ProcessGhExecutor(workspaceRoot));
  const recordedManager = await managerStore.load();
  const managerAgentId = recordedManager?.agentId ?? randomUUID() as AgentId;
  const coordinator = new DelegationCoordinator({ fleet, lease, terminals, configurations: workerConfigurations(workspaceRoot), prompts: new GitHubDelegationPromptResolver(new PromptResolver({ github })), spills: new FileSystemPromptSpillStore(workspaceRoot), managerAgentId, shell: process.platform === "win32" ? "powershell" : "git-bash", permissionMode: currentConfiguration.workerPermissionMode, maxInlinePromptChars: currentConfiguration.maxInlinePromptChars, agentIdFactory: () => randomUUID() as AgentId, sessionIdFactory: () => randomUUID() as SessionId });
  lifecycle = new WorkerLifecycleReconciler({ fleet, lease, completions: coordinator, workingTree: new GitWorkingTreeInspector() });
  const reviews = new ReviewCoordinator(github, coordinator, fleet);
  const briefings = new ManagerBriefings(
    briefingSources(workspaceRoot, github, () => recordedManager?.updatedAt),
    fleet,
    lease,
    {
      write: async (slice: BriefingSlice, content: string) => {
        const path = join(workspaceRoot, ".aboard", "runtime", "events", `brief-${slice}.txt`);
        await mkdir(join(workspaceRoot, ".aboard", "runtime", "events"), { recursive: true });
        await writeFile(path, content, "utf8");
        return path;
      },
    },
  );
  // The Stop hook long-polls: it must keep waiting while background workers are
  // live, and wake the moment one of them files a result.
  const managerStop = new ManagerStopService({
    fleet,
    waitForChange: (signal) => new Promise<void>((resolve) => {
      const registration = fleet.onDidChange(() => { registration.dispose(); signal.removeEventListener("abort", onAbort); resolve(); });
      const onAbort = (): void => { registration.dispose(); resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  });
  const managerPrompts = new ManagerPromptService(fleet, coordinator);
  bridge = await startBridge({
    preferredPort: currentConfiguration.bridgePort,
    handler: combineHandlers(createMcpHandler(coordinator, { github, reviews }), createManagerHookRoutes(briefings, managerStop, managerPrompts), createWorkerLifecycleRoutes(lifecycle), createWorkerHookRoutes(new WorkerHookService(fleet)), createTerminalRoutes(terminals)),
    persistence: new FileBridgeDiscoveryPersistence(workspaceRoot),
    logger: { info: (message) => output.appendLine(message), error: (message) => output.appendLine(`Error: ${message}`) },
  });
  bridgeEnvironment = { port: bridge.port, token: bridge.token };
  registerNativeFleetUi(context, bridge.port, fleet, lease, terminals);
  persistence = new PersistOnChange((listener) => fleet.onDidChange(listener), () => fleetStore.save(fleet.toPersistenceDto()), (error) => output.appendLine(`Fleet persistence failed: ${error instanceof Error ? error.message : "unknown error"}`));
  // Disposed through subscriptions like every other resource; `deactivate` also
  // awaits it so queued writes are flushed on a normal shutdown.
  context.subscriptions.push({ dispose: () => void persistence?.dispose() });
  const manager = new ManagerLifecycle({
    store: managerStore, terminals, workspaceRoot,
    shell: process.platform === "win32" ? "powershell" : "git-bash",
    preset: currentConfiguration.managerToolPreset,
    disallowedTools: currentConfiguration.managerDisallowedTools,
    agentIdFactory: () => managerAgentId,
  });
  const warnKey = "aboard.manager.permissionWarning";
  const launch = async (mode: "start" | "resume" | "new") => {
    const workerMode = currentConfiguration.workerPermissionMode;
    if (workerMode !== "bypass" && !context.globalState.get(warnKey)) { await window.showWarningMessage("Unattended workers may stall on permission prompts. For afk work, use the bypass permission mode."); await context.globalState.update(warnKey, true); }
    try {
      if (mode === "start" && await managerStore.load() !== undefined) {
        const choice = await window.showInformationMessage("A Manager session is already recorded. Resume it?", "Resume Manager", "New Manager");
        if (choice === undefined) return;
        mode = choice === "Resume Manager" ? "resume" : "new";
      }
      const terminal = await manager.start(mode);
      if (fleet.get(terminal.agentId) === undefined) fleet.register({ identity: { agentId: terminal.agentId, type: "manager" }, sessionId: terminal.sessionId, terminal: { terminalId: terminal.terminalId, name: terminal.name }, lifecycle: { status: "running", startedAt: new Date().toISOString() as IsoTimestamp }, resultDelivery: { mode: "none" }, telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 } } satisfies AgentSession, new Date().toISOString() as IsoTimestamp);
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to launch Manager"); }
  };
  context.subscriptions.push(
    commands.registerCommand("aboard.scaffoldProject", async () => {
      try {
        const autoCompactEnabled = workspace.getConfiguration("claudeCode").get<boolean>("autoCompact");
        const report = await scaffoldProject({
          projectRoot: workspaceRoot,
          assetRoot: join(context.extensionPath, "assets", "scaffold"),
          ...(autoCompactEnabled === undefined ? {} : { autoCompactEnabled }),
          todo: {
            ensure: async () => {
              try { await github.getTodo(); return "existing"; }
              catch (error) {
                if (!(error instanceof GitHubBoundaryError) || error.code !== "missing-todo") throw error;
                await github.updateTodo("# Project TODO\n\n- Add the next project priorities here."); return "created";
              }
            },
          },
        });
        for (const warning of report.warnings) { output.appendLine(`Warning: ${warning}`); void window.showWarningMessage(warning); }
        void window.showInformationMessage(`aboard project assets installed (${report.created.length} created, ${report.updated.length} updated, ${report.preserved.length} preserved).`);
      } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to scaffold aboard project assets"); }
    }),
    commands.registerCommand("aboard.startManager", () => launch("start")),
    commands.registerCommand("aboard.resumeManager", () => launch("resume")),
    commands.registerCommand("aboard.newManager", () => launch("new")),
    registerReviewCommand({ registerCommand: (command, callback) => commands.registerCommand(command, callback), input: async (options) => await window.showInputBox(options), error: (message) => { void window.showErrorMessage(message); } }, reviews),
  );
  context.subscriptions.push(workspace.onDidChangeConfiguration((event) => {
    if (!["aboard.bridge.port", "aboard.launch.maxInlinePromptChars", "aboard.manager.toolPreset", "aboard.manager.disallowedTools", "aboard.workers.permissionMode", "aboard.review.autoReview", "aboard.timeouts.managerStop", "aboard.timeouts.managerPrompt", "aboard.timeouts.managerSessionStart"].some((setting) => event.affectsConfiguration(setting))) return;
    const next = configuration(); currentConfiguration = next.value;
    for (const diagnostic of next.diagnostics) output.appendLine(`Configuration: ${diagnostic.message}`);
    if ([...MANAGER_RESTART_SETTINGS].some((setting) => event.affectsConfiguration(setting))) void window.showInformationMessage("Manager launch settings changed. Restart the Manager to apply them.");
  }));
  context.subscriptions.push({ dispose: () => void bridge?.stop() });
}

export async function deactivate(): Promise<void> {
  await persistence?.dispose();
  persistence = undefined;
  await bridge?.stop();
  bridge = undefined;
}
