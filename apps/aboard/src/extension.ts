import type { ExtensionContext } from "vscode";
import { ProgressLocation, RelativePattern, ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri, commands, env, window, workspace } from "vscode";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";


import {
  DEFAULT_BRIDGE_PORT,
  startBridge,
  type BridgeRuntime,
} from "./bridge/server.js";
import { createTerminalRoutes } from "./bridge/terminal-routes.js";
import { CommandTerminalService, createCommandRoutes, type CommandTerminalId } from "./bridge/command-terminals.js";
import { continueHarnessDelegation, createDelegationRoutes, readDelegationBinding } from "./bridge/manual-delegation.js";
import { FileCommandEndpointRegistry, commandEndpointDirectory } from "./bridge/command-endpoint.js";
import { TerminalController } from "./platform/terminals.js";
import type { TerminalId } from "./domain/contracts.js";
import { createVsCodeTerminalHost } from "./vscode/terminals.js";
import { spawnCommandRunner } from "./platform/preflight.js";
import { ClaudeAgentPlatform } from "./claude/platform.js";
import { ChatGptAgentPlatform } from "./chatgpt/platform.js";
import { AutoRunHookTrust } from "./chatgpt/hook-trust.js";
import type { AgentPlatform, AgentPlatformId } from "./platform/agent-platform.js";
import { GitHubBoundaryError, GitHubClient, ProcessGhExecutor } from "./github/client.js";
import { readScaffoldState, scaffoldCatalogRevision, scaffoldProject } from "./scaffold/project.js";
import { delimiter, join } from "node:path";
import { FleetRegistry } from "./domain/fleet.js";
import { WriteLease } from "./domain/lease.js";
import { registerNativeFleetUi, type NativeFleetUiRegistration } from "./vscode/native-ui.js";
import type { AutoRunPreview } from "./vscode/auto-run.js";
import {
  ABOARD_SETTINGS,
  EMPTY_PROJECT_SETTINGS,

  PROJECT_SETTINGS_PATH,
  createLayeredReader,

  parseProjectSettings,
  readAboardConfiguration,
  type ProjectSettings,
} from "./configuration.js";
import { FileActivityStore, FileFleetStore, PersistOnChange } from "./runtime/persistence.js";
import { ActivityRecorder } from "./runtime/activity-recorder.js";
import { isInteractiveLaunch, shouldRecordEndedSession, type AgentOutcome } from "./domain/activity.js";
import { completedCount } from "./domain/run-plan.js";
import { isLiveSession } from "./vscode/fleet.js";
import { ReopenCoordinator, describeReopenOutcome } from "./platform/reopen.js";
import { registerReopenCommand } from "./vscode/reopen.js";
import { combineHandlers } from "./bridge/router.js";
import { DelegationCoordinator, type DelegationConfigurationSource } from "./bridge/delegation.js";
import { WorkerHookService, createWorkerHookRoutes } from "./bridge/worker-hooks.js";
import { createPlatformLifecycleRoutes } from "./bridge/platform-lifecycle.js";
import { createAutoRoutes } from "./bridge/auto.js";

import { GitWorkingTreeInspector, WorkerLifecycleReconciler, reportsResult } from "./bridge/lifecycle.js";
import {
  SessionLifecycleService,
  SessionProcessMonitor,
  SessionStartCancelledError,
  SessionStartupProofs,
  type SessionEndReason,
} from "./bridge/session-lifecycle.js";
import { lockMarkerDirectory, lockMarkerLive, sessionExitFailure, sessionLaunchFailure, sessionWrapperLayout, takeSessionExitRecord, watchLockMarkers, type SessionExitRecord } from "./runtime/lock-markers.js";
import { WorkspaceAgentIdCounter } from "./runtime/agent-id-counter.js";
import { PromptResolver } from "./platform/prompts.js";
import { GitHubDelegationPromptResolver } from "./github/prompt-adapter.js";
import { FileSystemPromptSpillStore, createPromptSpillRoot } from "./platform/spill.js";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isHeadlessExecution, type AgentId, type AgentSession, type AgentType, type IsoTimestamp, type SessionId, type TerminalId as TerminalIdBrand } from "./domain/contracts.js";


/** Generous worker proof-of-life window: cold starts include `uv` resolving the hook shim and the agent CLI boot. */
const STARTUP_PROOF_TIMEOUT_MS = 60_000;
const SESSION_LIVENESS_POLL_MS = 5_000;

import { CachingGitClient, ProcessGitClient, type GitClient } from "./git/client.js";
import { AboardBranchCleanup, ProcessAboardBranchRepository } from "./git/branch-cleanup.js";
import { registerBranchCleanupCommand } from "./vscode/branch-cleanup.js";
import { registerLaunchPanel, type LaunchAction } from "./vscode/launch-panel.js";
import { AutoRunEngine } from "./auto/engine.js";
import { closeSettledAutoRunTerminal } from "./auto/terminal-cleanup.js";
import { WorktreeRunWorkspaces } from "./auto/worktree.js";

import { FileAutoRunStore } from "./runtime/persistence.js";
import { RuntimeAdmission, RuntimeStartup } from "./runtime/admission.js";
import { RuntimeLayout } from "./runtime/layout.js";
import { requireHarnessWorkerSkills } from "./claude/skills.js";
import { requireChatGptWorkerSkills } from "./chatgpt/skills.js";
import { FileLaunchConfigurationSource } from "./platform/launch-configuration.js";

let bridge: BridgeRuntime | undefined;
let commandEndpointRegistry: FileCommandEndpointRegistry | undefined;
let persistence: PersistOnChange | undefined;
let activeAutoRun: AutoRunEngine | undefined;

function configuration(project: ReadonlyMap<string, unknown>) {
  const scope = workspace.getConfiguration();
  return readAboardConfiguration(createLayeredReader({
    workspace: { get: (section) => { const found = scope.inspect(section); return found?.workspaceFolderValue ?? found?.workspaceValue; } },
    project,
    user: { get: (section) => { const found = scope.inspect(section); return found?.globalValue ?? found?.defaultValue; } },
  }));
}

async function readProjectSettings(workspaceRoot: string): Promise<ProjectSettings> {
  try { return parseProjectSettings(await readFile(join(workspaceRoot, ".abd", "settings.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_PROJECT_SETTINGS;
    return { values: new Map(), diagnostics: [{ setting: PROJECT_SETTINGS_PATH, severity: "error", message: `Unable to read ${PROJECT_SETTINGS_PATH}: ${error instanceof Error ? error.message : "unknown error"}. Project overrides are ignored.` }] };
  }
}


function workerConfigurations(workspaceRoot: string, source: FileLaunchConfigurationSource): DelegationConfigurationSource {
  const requireSkills = async (configured: Awaited<ReturnType<FileLaunchConfigurationSource["get"]>>, type: AgentType) => {
    if (type === "address" || type === "review") {
      if (configured.platform === "claude") await requireHarnessWorkerSkills(workspaceRoot);
      else await requireChatGptWorkerSkills(workspaceRoot);
    }
    return configured;
  };
  return {
    get: async (type) => requireSkills(await source.get(type), type),
    getFor: async (platform, type) => requireSkills(await source.getFor(platform, type), type),
    getDelegationFor: async (platform, task) => requireSkills(await source.getDelegationFor(platform, task), task === "explore" ? "explore" : "general"),
  };
}

/** Exposed so the VS Code integration suite can locate command discovery. */
export interface AboardExtensionApi {
  /** Where `/commands` publishes this window's port and command-scoped token. */
  readonly commandEndpointDirectory: string;
}

export async function activate(context: ExtensionContext): Promise<AboardExtensionApi | undefined> {
  if ((workspace.workspaceFolders?.length ?? 0) > 1) { void window.showErrorMessage("aboard v1 supports exactly one workspace folder. Open the project in a single-root window."); return undefined; }
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot === undefined) return undefined;
  const storageRoot = (context.storageUri ?? context.globalStorageUri).fsPath;
  const runtime = new RuntimeLayout(storageRoot);

  const output = window.createOutputChannel("aboard");
  context.subscriptions.push(output);
  let projectSettings = await readProjectSettings(workspaceRoot);
  const initialConfiguration = configuration(projectSettings.values);
  const initialDiagnostics = [...projectSettings.diagnostics, ...initialConfiguration.diagnostics];
  for (const diagnostic of initialDiagnostics) output.appendLine(`Configuration: ${diagnostic.message}`);
  if (initialDiagnostics.length > 0) void window.showWarningMessage(initialDiagnostics.map((item) => item.message).join(" "));
  let currentConfiguration = initialConfiguration.value;
  let bridgeEnvironment: { port: number; token: string } | undefined;
  // Declared early so the auto-run engine's change callback can refresh the
  // panel; assigned once the services it renders exist.
  let fleetUi: NativeFleetUiRegistration | undefined;
  let lifecycle: WorkerLifecycleReconciler | undefined;
  let sessionLifecycle: SessionLifecycleService | undefined;
  const sessionProofs = new SessionStartupProofs();
  const scaffoldAssetRoot = join(context.extensionPath, "assets", "scaffold");
  const expectedScaffoldRevision = await scaffoldCatalogRevision(scaffoldAssetRoot);
  let scaffoldState = await readScaffoldState(workspaceRoot, expectedScaffoldRevision).catch(() => "uninitialized" as const);
  let initialized = scaffoldState === "ready";
  let scaffoldUpdateWarningShown = false;
  const runtimeAdmission = new RuntimeAdmission(initialized);

  const requireInitialized = (): boolean => {
    if (initialized) return true;
    void window.showInformationMessage(scaffoldState === "update-required"
      ? "aboard's project assets must be updated before this extension version can use them. Run Update .abd/."
      : "aboard is not initialized in this workspace. Initialize it from the Get Started view first.");
    return false;
  };
  const terminals = new TerminalController({
    host: createVsCodeTerminalHost(),
    shell: process.platform === "win32" ? "powershell" : "git-bash",
    environment: () => {
      if (bridgeEnvironment === undefined) throw new Error("Bridge is not ready");
      return {
        ...bridgeEnvironment,
        workspaceRoot,
        runtimeRoot: runtime.root,
      };
    },
    terminalIdFactory: () => randomUUID() as TerminalId,
    startupProofs: sessionProofs,
    onStartupTimeout: (agentId, sessionId, timeoutMs) => {
      const label = fleet.get(agentId)?.terminal.name ?? `agent ${agentId}`;
      output.appendLine(`${label} (agent ${agentId}, session ${sessionId}) did not produce a lifecycle start observation within ${Math.round(timeoutMs / 1000)}s; closing the terminal as a failed launch.`);
      // Settle the timeout before TerminalController closes the terminal. Its
      // close event then observes an already-failed session instead of emitting
      // a second, misleading "killed" failure notification.
      void lifecycle?.timeout(agentId, sessionId).catch((error: unknown) => {
        output.appendLine(`Startup-timeout reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    },
    onLifecycleEvent: (event) => {
      if (event.type === "terminal-created") {
        sessionMonitor.trackLaunch({
          agentId: event.agentId,
          sessionId: event.sessionId,
          lockFile: wrapperLayout.lockPathFor(event.agentId),
        });
      }
      if (event.type === "terminal-closed") {
        activeAutoRun?.terminalClosed(event.terminalId);
        output.appendLine(`Terminal ${event.terminalId} closed (${event.reason}, exit ${event.exitCode ?? "unknown"})`);
        // The terminal close is authoritative: stop tracking the process so a
        // later poll does not report it as dead when the shell dumped it.
        sessionMonitor.untrack(event.agentId);
        sessionProofs.cancel(event.agentId);
      }
      if (event.type !== "terminal-closed") return;
      const closed = fleet?.get(event.agentId);
      if (closed === undefined) return;
      if (!reportsResult(closed)) {
        const occurredAt = event.occurredAt as IsoTimestamp;
        // The reconciler would have released the lease; do it here for the paths
        // that skip it, or an interactive agent's lease outlives its terminal.
        lease.releaseForTerminalOutcome(event.agentId, occurredAt, "agent terminal closed");
        void rememberEndedSession(closed, occurredAt);
        fleet.remove(event.agentId, occurredAt);
      } else void lifecycle?.terminalClosed(event).catch((error: unknown) => output.appendLine(`Lifecycle reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`));
    },
  });
  context.subscriptions.push({ dispose: () => terminals.dispose() });
  const commandTerminals = new CommandTerminalService({
    host: createVsCodeTerminalHost(),
    defaultCwd: () => workspaceRoot,
    idFactory: () => randomUUID() as CommandTerminalId,
    directoryExists: (path) => existsSync(path),
  });
  context.subscriptions.push({ dispose: () => commandTerminals.dispose() });
  const fleetStore = new FileFleetStore(runtime.root, runtimeAdmission);
  const persistedFleet = await fleetStore.load();
  const fleet = persistedFleet === undefined ? new FleetRegistry() : FleetRegistry.restore(persistedFleet);
  const activityListeners = new Set<() => void>();
  const activity = new ActivityRecorder({
    store: new FileActivityStore(runtime.root, runtimeAdmission),
    admission: () => initialized,
    now: () => new Date(),
    log: (message) => output.appendLine(message),
    onDidChange: () => { for (const listener of activityListeners) listener(); },
  });
  const launchFile = new FileLaunchConfigurationSource({
    project: join(workspaceRoot, ".harness", "launch.json"),
    global: join(homedir(), ".harness", "launch.json"),
  });
  const claudePlatform = new ClaudeAgentPlatform({
    commandRunner: spawnCommandRunner(workspaceRoot),
    lifecycleAssets: {
      settings: join(context.extensionPath, "assets", "runtime", "abd-hooks.json"),
      script: join(context.extensionPath, "assets", "runtime", "abd_hook.py"),
    },
  });
  const hookTrustKey = `aboard.autoRun.codexHooksAllowed:${workspaceRoot}`;
  const autoRunHookTrust = new AutoRunHookTrust({
    isAllowed: () => context.workspaceState.get<boolean>(hookTrustKey) === true,
    remember: async () => { await context.workspaceState.update(hookTrustKey, true); },
    ask: async () => await window.showWarningMessage(
      "Allow configured Codex hooks during Auto Run in this workspace?",
      { modal: true, detail: "Auto Run needs Aboard's guard and lifecycle hooks. This allows all enabled Codex hooks, including user and project hooks, without individual trust review during automated runs and worker resumes. Only allow this if you trust those hooks. Your choice is remembered for this workspace." },
      "Allow Hooks",
    ) === "Allow Hooks",
  });
  const chatGptPlatform = new ChatGptAgentPlatform({
    approveAutoRunHooks: () => autoRunHookTrust.approve(),
    commandRunner: spawnCommandRunner(workspaceRoot),
    lifecycleAssets: {
      settings: join(context.extensionPath, "assets", "runtime", "abd-hooks.json"),
      script: join(context.extensionPath, "assets", "runtime", "abd_hook.py"),
    },
  });
  const platforms: ReadonlyMap<AgentPlatformId, AgentPlatform> = new Map<AgentPlatformId, AgentPlatform>([
    [claudePlatform.id, claudePlatform],
    [chatGptPlatform.id, chatGptPlatform],
  ]);

  const sessionIsResumable = async (platformId: AgentSession["platform"], sessionId: SessionId, cwd: string, type?: AgentSession["identity"]["type"]): Promise<boolean> => {
    const platform = platforms.get(platformId);
    if (platform === undefined) return false;
    const configured = type === undefined ? undefined : await launchFile.get(type).catch(() => undefined);
    const settings = configured?.platform === platformId ? configured.settings : undefined;
    const command = typeof settings === "object" && settings !== null && "declaredCommand" in settings
      ? (settings as { readonly declaredCommand?: readonly string[] }).declaredCommand
      : undefined;
    return platform.isResumable(sessionId, cwd, command);
  };
  if (initialized) await activity.load().catch((error: unknown) => output.appendLine(`Activity store could not be read: ${error instanceof Error ? error.message : "unknown error"}`));
  const rememberEndedSession = async (
    session: AgentSession,
    endedAt: IsoTimestamp,
    outcome: Extract<AgentOutcome, "ended" | "failed" | "killed" | "interrupted"> = "ended",
    reason?: string,
  ): Promise<void> => {
    if (!initialized) return;
    // Capture this before the async transcript read: process-end settlement may
    // release the still-open terminal while the check is in flight.
    const terminalId = terminals.liveTerminalForAgent(session.identity.agentId);
    const conversationStarted = !isInteractiveLaunch(session)
      // A runtime-assigned id is proof that Codex created the conversation.
      || (session.platform === "chatgpt" && session.sessionBinding === "bound")
      || await sessionIsResumable(session.platform, session.sessionId, session.cwd ?? workspaceRoot, session.identity.type);
    if (!shouldRecordEndedSession(session, conversationStarted)) {
      output.appendLine(`Discarded empty session for agent ${session.identity.agentId}; no agent conversation started.`);
      return;
    }
    const classified = isInteractiveLaunch(session) ? outcome : outcome === "ended" ? "succeeded" : outcome;
    activity.recordAgent(session, classified, endedAt, {
      ...(reason === undefined ? {} : { reason }),
      ...(terminalId === undefined ? {} : { terminalId }),
    });
  };
  const github = new GitHubClient(new ProcessGhExecutor(workspaceRoot));
  let agentIdCounter = WorkspaceAgentIdCounter.load(runtime.root, () => fleet.list().map((session) => session.identity.agentId as string), runtimeAdmission.isOpen);
  const lease = new WriteLease();
  const launchConfigurations = workerConfigurations(workspaceRoot, launchFile);
  let launchFileNotice: string | undefined;
  const validateLaunchFile = async (): Promise<void> => {
    if (!initialized) return;
    try {
      const parsed = await launchFile.load();
      const notice = parsed.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
      if (notice.length > 0) output.appendLine(`Launch configuration: ${notice}`);
      if (notice.length > 0 && notice !== launchFileNotice) void window.showWarningMessage(notice);
      if (launchFileNotice !== undefined && notice.length === 0) void window.showInformationMessage("Launch configuration is valid. New and reopened sessions use it.");
      launchFileNotice = notice.length === 0 ? undefined : notice;
    } catch (error) {
      const notice = error instanceof Error ? error.message : "Invalid .harness/launch.json";
      output.appendLine(`Launch configuration: ${notice}`);
      if (notice !== launchFileNotice) void window.showErrorMessage(`${notice}. New and reopened sessions are blocked until it is fixed.`);
      launchFileNotice = notice;
    }
  };
  await validateLaunchFile();
  const promptRoot = await createPromptSpillRoot();
  context.subscriptions.push({ dispose: () => { void rm(promptRoot, { recursive: true, force: true }); } });
  const runtimeFiles = new FileSystemPromptSpillStore(
    workspaceRoot,
    runtime.root,
    new Map([...platforms.values()].map((platform) => [platform.id, platform.lifecycleAssets])),
    { admission: runtimeAdmission, promptRoot },
  );
  const liveTaskAgents = new Set(fleet.list().map((session) => session.identity.agentId as string));
  await runtimeFiles.prune(liveTaskAgents, new Set([
    ...liveTaskAgents,
    ...activity.entries().flatMap((entry) => entry.kind === "agent" && entry.reopen !== undefined ? [entry.agentId as string] : []),
  ]));
  const wrapperLayout = sessionWrapperLayout(runtime.root, join(context.extensionPath, "assets", "runtime", "abd_wrapper.py"));
  // `sessionMonitor` is constructed below, after the settlement callbacks it
  // needs; the observer is only ever called from a launch, long after that.
  const coordinator = new DelegationCoordinator({ admission: () => initialized, workspaceRoot, promptRoot, fleet, lease, terminals, sessions: { observe: (agentId) => sessionMonitor.observe(agentId) }, onStaleLeaseRecovered: (holder, observation) => { output.appendLine(`Reclaimed the write lease from ${holder.agentId} (held since ${holder.acquiredAt}): terminal ${observation.terminal}, session ${observation.session}.`); void window.showWarningMessage(`aboard reclaimed the write lease from ${holder.agentId}: its terminal and session are both gone.`); }, configurations: launchConfigurations, platforms, prompts: new GitHubDelegationPromptResolver(new PromptResolver({ github })), spills: runtimeFiles, shell: process.platform === "win32" ? "powershell" : "git-bash", maxInlinePromptChars: currentConfiguration.maxInlinePromptChars, agentIdFactory: () => agentIdCounter.next(), startupTimeoutMs: STARTUP_PROOF_TIMEOUT_MS, wrapper: wrapperLayout, lockProbe: lockMarkerLive });
  lifecycle = new WorkerLifecycleReconciler({
    fleet,
    lease,
    completions: coordinator,
    workingTree: new GitWorkingTreeInspector(),
    onFinished: (session, result) => {
      if (!initialized) return;
      const at = new Date().toISOString() as IsoTimestamp;
      activity.recordAgent(
        session,
        result.outcome === "succeeded" ? "succeeded" : result.failure.type === "killed" ? "cancelled" : "failed",
        at,
        result.outcome === "failed" ? { reason: result.failure.type } : {},
      );
    },
  });
  const releaseAbandonedTerminal = (agentId: AgentId, autoRunOwnsTerminal = false): void => {
    const terminalId = terminals.liveTerminalForAgent(agentId);
    if (terminalId === undefined) return;
    // Auto-run closes its successful workers as soon as their results have
    // been consumed and retains every other terminal for recovery or cleanup.
    if (autoRunOwnsTerminal) return;
    if (currentConfiguration.closeTerminalOnSessionEnd) {
      try { terminals.kill(terminalId); } catch { /* already closed */ }
      return;
    }
    terminals.release(terminalId);
  };
  const settlePreSessionExit = (agentId: AgentId, sessionId: SessionId, exit: SessionExitRecord | undefined): void => {
    const cause = sessionLaunchFailure(exit);
    if (cause === undefined) {
      sessionProofs.cancel(agentId);
      const at = new Date().toISOString() as IsoTimestamp;
      const ended = fleet.get(agentId);
      if (ended !== undefined) {
        lease.releaseForTerminalOutcome(agentId, at, "agent exited before entering a conversation");
        void rememberEndedSession(ended, at);
        fleet.remove(agentId, at);
      }
      releaseAbandonedTerminal(agentId);
      output.appendLine(`Agent ${agentId} exited cleanly before starting a session`);
      return;
    }
    output.appendLine(`Launch failed for agent ${agentId} (session ${sessionId}): the configured agent command ${cause}. The terminal holds the error.`);
    // The launch is settled; the proof's timeout must not fire later and kill a
    // terminal whose error message is the whole point of keeping it.
    sessionProofs.cancel(agentId);
    const at = new Date().toISOString() as IsoTimestamp;
    const failed = fleet.get(agentId);
    if (failed !== undefined) {
      lease.releaseForTerminalOutcome(agentId, at, "launch failed before the session started");
      // Recorded before the fleet forgets it: a launch that died on its way up
      // leaves nothing else behind but the terminal holding the error text.
      if (initialized) activity.recordAgent(failed, "launch-failed", at, { reason: cause });
      fleet.remove(agentId, at);
    }
    releaseAbandonedTerminal(agentId);
    void window.showWarningMessage(`aboard could not start the configured agent: it ${cause}. Check the terminal for the error.`);
  };
  const sessionMonitor = new SessionProcessMonitor({
    probe: lockMarkerLive,
    debug: (message) => output.appendLine(`[liveness] ${message}`),
    onProcessEnded: (observation) => {
      // The exit record is consumed either way, so a spent one can never be
      // read back against a later launch of the same agent.
      const exit = takeSessionExitRecord(observation.lockFile);
      void runtimeFiles.remove?.(observation.agentId).catch(() => undefined);
      if (observation.phase === "launching") {
        settlePreSessionExit(observation.agentId, observation.sessionId, exit);
        return;
      }
      const session = fleet.get(observation.agentId);
      if (session === undefined) return;
      const at = new Date().toISOString() as IsoTimestamp;
      if (!reportsResult(session)) {
        lease.releaseForTerminalOutcome(observation.agentId, at, "agent session process ended");
        const failure = sessionExitFailure(exit);
        void rememberEndedSession(session, at, failure === undefined ? "ended" : "failed", failure);
        fleet.remove(observation.agentId, at);
        releaseAbandonedTerminal(observation.agentId, session.autoRunRestricted === true);
        output.appendLine(`Session process for agent ${observation.agentId} ended`);
        return;
      }
      void lifecycle?.processEnded(observation)
        .then(() => releaseAbandonedTerminal(observation.agentId, session.autoRunRestricted === true))
        .catch((error: unknown) => output.appendLine(`Process-end reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`));
    },
  });
  const settleConversationEnded = (agentId: AgentId, reason: SessionEndReason): void => {
    const session = fleet.get(agentId);
    if (session === undefined) return;
    const at = new Date().toISOString() as IsoTimestamp;
    output.appendLine(`Conversation for agent ${agentId} ended (${reason}); the terminal stays open`);
      if (!reportsResult(session)) {
        lease.releaseForTerminalOutcome(agentId, at, `agent session ended (${reason})`);
        void rememberEndedSession(session, at);
        fleet.remove(agentId, at);
        releaseAbandonedTerminal(agentId, session.autoRunRestricted === true);
        return;
      }
      void lifecycle?.processEnded({ agentId, sessionId: session.sessionId })
        .then(() => releaseAbandonedTerminal(agentId, session.autoRunRestricted === true))
        .catch((error: unknown) => output.appendLine(`Session-end reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`));
  };
  sessionLifecycle = new SessionLifecycleService({
    fleet,
    monitor: sessionMonitor,
    settlement: { settleConversationEnded },
    lockPathFor: wrapperLayout.lockPathFor,
    onSessionStarted: (observation) => {
      output.appendLine(`Session ${observation.sessionId} for agent ${observation.agentId} started`);
    },
  });
  context.subscriptions.push({ dispose: () => sessionLifecycle?.dispose() });
  sessionMonitor.start(SESSION_LIVENESS_POLL_MS);
  try {
    const markerWatch = watchLockMarkers(lockMarkerDirectory(runtime.root), () => sessionMonitor.poll());
    context.subscriptions.push({ dispose: () => markerWatch.dispose() });
  } catch (error) {
    output.appendLine(`Could not watch session lock markers; falling back to polling only. ${error instanceof Error ? error.message : "unknown error"}`);
  }
  activeSessionMonitor = sessionMonitor;
  const git: GitClient = new CachingGitClient(new ProcessGitClient(workspaceRoot));
  const branchCleanup = new AboardBranchCleanup(new ProcessAboardBranchRepository(workspaceRoot), github);
  const autoRun = new AutoRunEngine({
    git,
    gitFor: (cwd) => new CachingGitClient(new ProcessGitClient(cwd)),
    workspaceRoot,
    // Where a run works. In its own checkout beside the project when the user
    // asked for one, in their files otherwise.
    workspaces: new WorktreeRunWorkspaces({
      workspaceRoot,
      git,
      gitFor: (cwd) => new CachingGitClient(new ProcessGitClient(cwd)),
      settings: () => currentConfiguration.autoRun.worktree,
      notify: (message) => output.appendLine(message),
      log: (message) => output.appendLine(message),
      // Auto Run's own provider has to enforce the boundary, so it is the one
      // asked whether the project path is representable at all.
      requireEnforceableIsolation: async (protectedPaths) => {
        const provider = (await launchFile.load()).value.autoRunProvider;
        platforms.get(provider)?.requireEnforceableRestrictions({ protectedPaths });
      },
    }),
    github,
    launcher: coordinator,
    terminals: { close: (terminalId) => closeSettledAutoRunTerminal(terminals, fleet, terminalId) },
    store: new FileAutoRunStore(runtime, runtimeAdmission),
    notifier: {
      notify: (message) => output.appendLine(message),
      alert: (message, pullRequestUrl) => { alertAboutAutoRun(message, pullRequestUrl); },
    },
    activity: {
      runStarted: (record, resumed) => activity.recordRun({
        runId: record.runId,
        attempt: record.attempt,
        outcome: resumed ? "resumed" : "started",
        issueNumbers: record.plan.map((issue) => issue.number),
      }),
      runEnded: (record, outcome) => activity.recordRun({
        runId: record.runId,
        attempt: record.attempt,
        outcome: outcome === "succeeded" ? "succeeded" : outcome.kind,
        ...(outcome !== "succeeded" && outcome.kind === "failed" ? { reason: outcome.reason } : {}),
        issueNumbers: record.plan.map((issue) => issue.number),
        completedIssues: completedCount(record),
        totalIssues: record.plan.length,
        ...(record.currentIssue === undefined ? {} : { currentIssue: record.currentIssue }),
        ...(record.runPullRequest === undefined ? {} : { pullRequest: record.runPullRequest }),
      }),
      runDiscarded: (record) => activity.recordRun({
        runId: record.runId,
        attempt: record.attempt,
        outcome: "discarded",
        issueNumbers: record.plan.map((issue) => issue.number),
      }),
    },
    settings: () => currentConfiguration.autoRun,
    discardBehavior: () => currentConfiguration.autoRun.discardBehavior,
    log: (message) => output.appendLine(message),
    onStateChange: (state) => void publishAutoRunState(state),
    onRecordChange: () => fleetUi?.refresh(),
  });
  activeAutoRun = autoRun;
  const reopen = new ReopenCoordinator({
    nextMessage: async (candidate) => window.showInputBox({ prompt: `Next message for ${candidate.agentId}`, ignoreFocusOut: true, validateInput: (message) => message.trim() ? undefined : "A continuation requires a next message" }),
    activity: { entries: () => activity.store() },
    fleet,
    terminals: {
      isOpen: (terminalId) => terminals.list().some((terminal) => terminal.terminalId === terminalId && terminal.status === "open"),
      liveTerminalFor: (agentId) => terminals.liveTerminalForAgent(agentId),
      show: (terminalId) => terminals.show(terminalId),
    },
    launcher: { reopen: async (target) => {
      const handles = await continueHarnessDelegation(join(runtime.root, "delegations"), target, async (binding, message) => {
        await promisify(execFile)(binding.harnessPython ?? "python", ["-m", "subagents_runtime.cli", "resume", binding.harnessSessionId!, message], {
          cwd: binding.cwd, windowsHide: true, timeout: 30_000,
          env: { ...process.env, HARNESS_SESSION_ID: binding.parentSessionId!,
            ...(binding.harnessStateDirectory === undefined ? {} : { HARNESS_STATE_DIR: binding.harnessStateDirectory }),
            ...(binding.harnessRuntimePath === undefined ? {} : { PYTHONPATH: [binding.harnessRuntimePath, process.env.PYTHONPATH].filter(Boolean).join(delimiter) }) },
        });
      });
      return handles === undefined ? coordinator.reopen(target)
        : { agentId: handles.agentId as AgentId, sessionId: handles.sessionId as SessionId, terminalId: handles.terminalId as TerminalId };
    } },
    isResumable: (platform, sessionId, cwd, type) => sessionIsResumable(platform, sessionId, cwd ?? workspaceRoot, type),
  });
  const commandEndpoint = new FileCommandEndpointRegistry({ directory: commandEndpointDirectory(process.platform, process.env, homedir()) });
  await commandEndpoint.clearWorkspace(workspaceRoot).catch(() => undefined);
  commandEndpointRegistry = commandEndpoint;
  context.subscriptions.push({ dispose: () => void commandEndpoint.clear() });
  const bridgeStartup = new RuntimeStartup(runtimeAdmission);
  const startRuntimeBridge = (): Promise<void> => {
    if (!initialized || bridge !== undefined) return Promise.resolve();
    return bridgeStartup.run(async () => {
    if (!initialized || bridge !== undefined) return;
    const workerHooks = new WorkerHookService(fleet, runtimeFiles);
    bridge = await startBridge({
    preferredPort: currentConfiguration.bridgePort,
    handler: combineHandlers(
      createAutoRoutes({
        dryRun: (options) => autoRun.dryRun(options),
        start: async (options) => {
          if ((await launchFile.load()).value.autoRunProvider === "chatgpt" && !await autoRunHookTrust.approve()) {
            return { started: false as const, reason: "Codex Auto Run requires workspace hook consent" };
          }
          return autoRun.start(options);
        },
      }),
      createPlatformLifecycleRoutes({ fleet, platforms, sessions: sessionLifecycle, workers: lifecycle, compactions: workerHooks, sessionBindings: [lease, terminals], proofs: sessionProofs }),
      createWorkerHookRoutes(workerHooks),
      createTerminalRoutes(terminals),
      createCommandRoutes(commandTerminals),
      createDelegationRoutes({ launch: async (request) => {
        const configured = await launchFile.getDelegationFor(request.provider, request.task);
        return coordinator.launchManual({
          requestId: request.requestId,
          ...(request.harnessStateDirectory === undefined ? {} : { harnessStateDirectory: request.harnessStateDirectory }),
          ...(request.harnessRuntimePath === undefined ? {} : { harnessRuntimePath: request.harnessRuntimePath }),
          ...(request.harnessSessionId === undefined ? {} : { harnessSessionId: request.harnessSessionId }),
          ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
          type: request.type,
          prompt: request.prompt,
          ...(request.skill === undefined ? {} : { skill: request.skill }),
          description: request.description,
          isolation: { cwd: request.cwd, protectedPaths: [], writableRoots: [] },
          executionMode: request.executionMode,
          configuration: configured,
        }, request.executionMode);
      }, resume: async (request) => {
        if (!request.harnessSessionId) throw new Error("Delegated resume requires its stable Harness identity");
        const binding = await readDelegationBinding(join(runtime.root,"delegations"),request.harnessSessionId);
        if (!binding || binding.agentId !== request.resumeAgentId || binding.sessionId !== request.resumeSessionId || binding.provider !== request.provider || binding.executionMode !== request.executionMode || binding.cwd !== request.cwd || binding.parentSessionId !== request.parentSessionId) throw new Error("Delegated session ownership or execution mode does not match");
        if (request.forkSessionId !== undefined) {
          const configured = await launchFile.getDelegationFor(binding.provider, binding.task);
          return coordinator.launchManual({
            forkSessionId: request.forkSessionId as SessionId,
            requestId: request.requestId,
            harnessSessionId: request.harnessSessionId,
            ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
            ...(request.harnessStateDirectory === undefined ? {} : { harnessStateDirectory: request.harnessStateDirectory }),
            ...(request.harnessRuntimePath === undefined ? {} : { harnessRuntimePath: request.harnessRuntimePath }),
            type: binding.type, prompt: request.prompt, description: binding.description,
            isolation: { cwd: binding.cwd, protectedPaths: [], writableRoots: [] },
            executionMode: binding.executionMode, configuration: configured,
          }, binding.executionMode);
        }
        if (lockMarkerLive(wrapperLayout.lockPathFor(binding.agentId as AgentId))) throw new Error("Delegated execution is running or uncertain; resume refused");
        const saved = fleet.get(binding.agentId as AgentId);
        return coordinator.reopen({ platform: binding.provider, agentId: binding.agentId as AgentId, type: binding.type, delegationTask: binding.task, sessionId: binding.sessionId as SessionId, terminalName: saved?.terminal.name ?? `aboard: ${binding.description}`, executionMode: binding.executionMode, cwd: binding.cwd, prompt: request.prompt, resultDelivery: saved?.resultDelivery ?? { mode:"none" }, harnessSessionId: request.harnessSessionId, ...(request.executionId === undefined ? {} : { executionId: request.executionId }), ...(request.harnessStateDirectory === undefined ? {} : { harnessStateDirectory: request.harnessStateDirectory }), ...(request.harnessRuntimePath === undefined ? {} : { harnessRuntimePath: request.harnessRuntimePath }), requestId: request.requestId });
      } }, {
        workspaceRoot,
        stateDirectory: join(runtime.root, "delegations"),
        focusParent: (sessionId) => {
          const parent = fleet.getBySession(sessionId as SessionId);
          if (parent === undefined) return false;
          const terminalId = terminals.liveTerminalForAgent(parent.identity.agentId);
          if (terminalId === undefined) return false;
          terminals.show(terminalId);
          return true;
        },
      }),
    ),
    logger: { info: (message) => output.appendLine(message), error: (message) => output.appendLine(`Error: ${message}`) },
    });
    bridgeEnvironment = { port: bridge.port, token: bridge.token };
    try {
    const published = await commandEndpoint.publish({
      version: 2,
      host: bridge.host,
      port: bridge.port,
      workspaceRoot,
      commandToken: bridge.commandToken,
      delegationToken: bridge.delegationToken,
      pid: process.pid,
      activatedAt: new Date().toISOString(),
    });
    output.appendLine(`Command endpoint published at ${published}`);
    } catch (error) {
    // A script losing its way in is worth a line; it is not worth refusing to
    // activate, and every other route reaches the bridge without this file.
    output.appendLine(`Command endpoint could not be published: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    });
  };
  await startRuntimeBridge();
  const startAutoRun = async (preview: AutoRunPreview) => {
    if (!requireInitialized()) return { started: false as const, reason: "the project is not initialized" };
    if ((await launchFile.load()).value.autoRunProvider === "chatgpt" && !await autoRunHookTrust.approve()) {
      return { started: false as const, reason: "Codex Auto Run requires workspace hook consent" };
    }
    return autoRun.startPreviewed(preview);
  };
  fleetUi = registerNativeFleetUi(context, {
    port: () => bridge?.port,
    fleet,
    lease,
    terminals,
    isInitialized: () => initialized,
    isResumable: sessionIsResumable,
    autoRun: {
      engine: autoRun,
      discardBehavior: () => currentConfiguration.autoRun.discardBehavior,
      webUrl: (number) => github.webUrl(number),
      start: (preview) => startAutoRun(preview),
    },
    activity: {
      entries: () => activity.entries(),
      store: () => activity.store(),
      clear: () => activity.clear(),
      reopen: async (entry) => {
        if (entry.kind !== "agent") return;
        const option = await reopen.find(entry.agentId);
        if (option === undefined) { void window.showInformationMessage("aboard no longer has enough about that session to reopen it."); return; }
        const outcome = await reopen.reopen(option.candidate);
        if (outcome.action === "unresumable") void window.showWarningMessage(describeReopenOutcome(outcome));
        else if (outcome.action === "none") void window.showInformationMessage(describeReopenOutcome(outcome));
      },
      showTerminal: (entry) => {
        if (entry.kind !== "agent" || entry.terminalId === undefined) return;
        try { terminals.show(entry.terminalId); } catch { void window.showInformationMessage("That terminal has closed."); }
      },
      onDidChange: (listener) => { activityListeners.add(listener); return { dispose: () => activityListeners.delete(listener) }; },
    },
  });

  const alertAboutAutoRun = (message: string, pullRequestUrl?: string): void => {
    output.appendLine(message);
    const actions = pullRequestUrl === undefined ? ["Show Log"] : ["Open Pull Request", "Show Log"];
    void window.showWarningMessage(message, ...actions).then((choice) => {
      if (choice === "Open Pull Request" && pullRequestUrl !== undefined) void env.openExternal(Uri.parse(pullRequestUrl));
      else if (choice === "Show Log") output.show(true);
    });
  };
  const publishAutoRunState = async (state: ReturnType<AutoRunEngine["state"]> | undefined): Promise<void> => {
    fleetUi?.refresh();
    await commands.executeCommand("setContext", "aboard.autoRunActive", state !== undefined);
  };
  await publishAutoRunState(undefined);
  // Persisting into an uninitialized project would recreate `.abd/` behind the
  // user's back; including right after they deleted it.
  persistence = new PersistOnChange((listener) => fleet.onDidChange(listener), async () => { if (initialized) await fleetStore.save(fleet.toPersistenceDto()); }, (error) => output.appendLine(`Fleet persistence failed: ${error instanceof Error ? error.message : "unknown error"}`));
  // Disposed through subscriptions like every other resource; `deactivate` also
  // awaits it so queued writes are flushed on a normal shutdown.
  context.subscriptions.push({ dispose: () => void persistence?.dispose() });
  const providers = {
    claude: { label: "Claude", description: "Claude Code", provider: "claude" as const },
    chatgpt: { label: "ChatGPT", description: "Codex CLI", provider: "chatgpt" as const },
  };
  const runAgentOn = async (choice: (typeof providers)[keyof typeof providers]): Promise<void> => {
    if (!requireInitialized()) return;
    try {
      await coordinator.launchInteractive({
        type: "interactive",
        description: `${choice.label} interactive`,
        configuration: await launchFile.getFor(choice.provider, "interactive"),
      }, "user");
    } catch (error) {
      if (error instanceof SessionStartCancelledError) return;
      void window.showErrorMessage(error instanceof Error ? error.message : "Unable to run agent");
    }
  };
  const runAgent = async (): Promise<void> => {
    if (!requireInitialized()) return;
    const selected = await window.showQuickPick(Object.values(providers), { placeHolder: "Choose the provider for this agent" });
    if (selected === undefined) return;
    await runAgentOn(selected);
  };
  const reconcileStaleSessions = (): void => {
    const openTerminalIds = new Set(terminals.list().filter((terminal) => terminal.status === "open").map((terminal) => terminal.terminalId));
    const stale = fleet.list().filter((session) => isLiveSession(session) && !openTerminalIds.has(session.terminal.terminalId));
    for (const session of stale) {
      if (isHeadlessExecution(session.identity.type, session.executionMode)) {
        // Detached wrappers outlive the extension. Restore observation without spawning.
        const lockFile = wrapperLayout.lockPathFor(session.identity.agentId);
        sessionMonitor.track({ agentId: session.identity.agentId, sessionId: session.sessionId, lockFile });
        continue;
      }
      const at = new Date().toISOString() as IsoTimestamp;
      if (initialized) void rememberEndedSession(session, at, "interrupted", "the extension host restarted under it");
      // A lease held by an agent whose terminal is gone would block every later
      // write-capable launch.
      lease.releaseForTerminalOutcome(session.identity.agentId, at, "session did not survive the extension host");
      fleet.remove(session.identity.agentId, at);
      void runtimeFiles.remove?.(session.identity.agentId).catch(() => undefined);
      output.appendLine(`Removed interrupted ${session.identity.type} (agent ${session.identity.agentId}) from the fleet.`);
    }
  };
  reconcileStaleSessions();


  const publishScaffoldState = async () => {
    const wasInitialized = initialized;
    scaffoldState = await readScaffoldState(workspaceRoot, expectedScaffoldRevision).catch(() => "uninitialized" as const);
    const next = scaffoldState === "ready";
    if (initialized && !next) {
      initialized = false;
      const runtimeDrained = runtimeAdmission.close();

      const reason = scaffoldState === "uninitialized" ? "project state was removed" : "project assets became incompatible";
      autoRun.stop(reason);
      await autoRun.settle();
      await runtimeDrained;
      for (const terminal of terminals.list()) {
        if (terminal.status === "open") try { terminals.kill(terminal.terminalId); } catch { /* already closing */ }
      }
      const at = new Date().toISOString() as IsoTimestamp;
      if (lease.current() !== undefined) lease.forceRelease(at, reason);
      fleet.clear(at);
      await activity.reset();

      bridgeEnvironment = undefined;
      await bridge?.stop();
      bridge = undefined;
      await commandEndpoint.clear().catch(() => undefined);
      await rm(runtime.root, { recursive: true, force: true });
      output.appendLine(scaffoldState === "uninitialized"
        ? "Project state directory .abd/ was removed; the aboard session was discarded."
        : "aboard's project assets no longer match this extension; runtime access was closed until they are updated.");
    }
    initialized = next;
    if (initialized && !wasInitialized) {
      runtimeAdmission.open();
      agentIdCounter = WorkspaceAgentIdCounter.load(runtime.root, () => fleet.list().map((session) => session.identity.agentId as string), runtimeAdmission.isOpen);
      // The store on disk is the only history a newly initialized project has.
      await activity.load().catch((error: unknown) => output.appendLine(`Activity store could not be read: ${error instanceof Error ? error.message : "unknown error"}`));

    }
    if (initialized) await startRuntimeBridge();
    await commands.executeCommand("setContext", "aboard.initialized", next);
    await commands.executeCommand("setContext", "aboard.scaffoldUpdateRequired", scaffoldState === "update-required");
    if (scaffoldState !== "update-required") scaffoldUpdateWarningShown = false;
    if (scaffoldState === "update-required" && !scaffoldUpdateWarningShown) {
      scaffoldUpdateWarningShown = true;
      void window.showWarningMessage("aboard's project assets were created by another extension version. Update .abd/ before starting or resuming aboard.");
    }
    fleetUi.refresh();
  };
  await publishScaffoldState();
  const scaffoldWatcher = workspace.createFileSystemWatcher(new RelativePattern(workspaceRoot, ".abd/**"));
  for (const event of [scaffoldWatcher.onDidCreate, scaffoldWatcher.onDidChange, scaffoldWatcher.onDidDelete]) {
    context.subscriptions.push(event(() => void publishScaffoldState().then(validateLaunchFile)));
  }
  context.subscriptions.push(
    scaffoldWatcher,
    window.onDidChangeWindowState((state) => { if (state.focused) void publishScaffoldState(); }),
  );
  const scaffold = async () => {
    try {
      // Only set when Claude Code is installed; its workers are the ones a
      // disabled auto-compact would cut off mid-run.
      const autoCompactEnabled = workspace.getConfiguration("claudeCode").get<boolean>("autoCompact");
      const first = await readScaffoldState(workspaceRoot, expectedScaffoldRevision) === "uninitialized";
      const report = await scaffoldProject({
        projectRoot: workspaceRoot,
        assetRoot: scaffoldAssetRoot,
        ...(autoCompactEnabled === undefined ? {} : { autoCompactEnabled }),
      });
      for (const warning of report.warnings) { output.appendLine(`Warning: ${warning}`); void window.showWarningMessage(warning); }
      output.appendLine(`aboard ${first ? "initialized" : "updated"} (${report.created.length} created, ${report.updated.length} updated, ${report.removed.length} removed, ${report.preserved.length} preserved).`);
      if (report.preserved.length > 0) {
        output.appendLine("Preserved locally changed aboard assets:");
        for (const path of report.preserved) output.appendLine(`  ${path}`);
        void window.showWarningMessage(`${report.preserved.length} locally changed aboard asset${report.preserved.length === 1 ? " was" : "s were"} preserved. See the aboard Output channel for the file list.`);
      }
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to scaffold aboard project assets"); }
    finally { await publishScaffoldState(); await validateLaunchFile(); }
  };
  context.subscriptions.push(
    commands.registerCommand("aboard.initializeProject", scaffold),
    commands.registerCommand("aboard.updateProject", async () => {
      if (scaffoldState === "uninitialized") { requireInitialized(); return; }
      const confirmed = await window.showWarningMessage(
        "Update aboard's project assets?",
        {
          modal: true,
          detail: "aboard updates the extension-owned configuration and setup scripts under .abd/. Files you have not touched are replaced with this version's copies, and unchanged files this version retired are removed. Assets you edited yourself are kept and listed afterwards rather than overwritten. Running sessions continue unchanged.",
        },
        "Update",
      );
      if (confirmed === "Update") await scaffold();
    }),
    commands.registerCommand("aboard.runAgent", runAgent),
    // The rows above the fleet skip the picker: each one already names its provider.
    commands.registerCommand("aboard.runClaudeCode", () => runAgentOn(providers.claude)),
    commands.registerCommand("aboard.runCodex", () => runAgentOn(providers.chatgpt)),
    registerLaunchPanel({
      registerTreeDataProvider: (viewId, provider) => window.registerTreeDataProvider<LaunchAction>(viewId, {
        getChildren: (node) => [...provider.getChildren(node)],
        getTreeItem: (node) => {
          const row = provider.getTreeItem(node);
          const item = new TreeItem(row.label, TreeItemCollapsibleState.None);
          item.iconPath = new ThemeIcon(row.icon);
          item.contextValue = row.contextValue;
          item.command = { ...row.command };
          return item;
        },
      }),
    }),
    registerBranchCleanupCommand({
      registerCommand: (command, callback) => commands.registerCommand(command, async () => {
        if (!requireInitialized()) return;
        if (autoRun.state() !== undefined) { void window.showWarningMessage("Stop the active auto-run before clearing aboard branches."); return; }
        await callback();
      }),
      progress: (title, task) => Promise.resolve(window.withProgress({ location: ProgressLocation.Window, title }, task)),
      confirm: async (message, detail, action) => window.showWarningMessage(message, { modal: true, detail }, action),
      info: (message) => { void window.showInformationMessage(message); },
      error: (message) => { void window.showErrorMessage(message); },
    }, branchCleanup),

    registerReopenCommand({
      registerCommand: (command, callback) => commands.registerCommand(command, (...args) => requireInitialized() ? callback(...args) : undefined),
      // `matchOnDetail` so "ended", or an age, filters the list, which is how a
      // user with a long history finds the one they mean.
      pick: async (items, placeHolder) => window.showQuickPick([...items], { placeHolder, matchOnDescription: true, matchOnDetail: true }),
      info: (message) => { void window.showInformationMessage(message); },
      warning: (message) => { void window.showWarningMessage(message); },
      error: (message) => { void window.showErrorMessage(message); },
    }, reopen),
    commands.registerCommand("aboard.stopAutoRun", () => { if (requireInitialized()) autoRun.stop(); }),
    workspace.onDidSaveTextDocument(() => autoRun.repositoryChanged()),
    window.onDidChangeWindowState((state) => {
      if (state.focused) autoRun.repositoryChanged();
    }),
  );
  // Recovery has no notification: the Auto Run view is the place, and it
  // revalidates on activation, on visibility, on focus, and on a timer.
  void autoRun.refresh();
  const reloadConfiguration = (restartHint: (before: typeof currentConfiguration, after: typeof currentConfiguration) => boolean) => {
    const next = configuration(projectSettings.values);
    const previous = currentConfiguration;
    currentConfiguration = next.value;

    fleetUi?.checkAutoRun();
    for (const diagnostic of [...projectSettings.diagnostics, ...next.diagnostics]) output.appendLine(`Configuration: ${diagnostic.message}`);
    if (restartHint(previous, next.value)) void window.showInformationMessage("Launch settings changed. New and reopened sessions use the updated values.");
  };
  context.subscriptions.push(workspace.onDidChangeConfiguration((event) => {
    if (!ABOARD_SETTINGS.some((setting) => event.affectsConfiguration(setting))) return;
    reloadConfiguration(() => false);
  }));
  const settingsWatcher = workspace.createFileSystemWatcher(new RelativePattern(workspaceRoot, PROJECT_SETTINGS_PATH));
  const reloadProjectSettings = async () => {
    projectSettings = await readProjectSettings(workspaceRoot);
    reloadConfiguration(() => false);
  };
  for (const event of [settingsWatcher.onDidCreate, settingsWatcher.onDidChange, settingsWatcher.onDidDelete]) {
    context.subscriptions.push(event(() => void reloadProjectSettings()));
  }
  context.subscriptions.push(settingsWatcher);
  context.subscriptions.push({ dispose: () => void bridge?.stop() });
  return { commandEndpointDirectory: commandEndpoint.directory };
}

let activeSessionMonitor: SessionProcessMonitor | undefined;

export async function deactivate(): Promise<void> {
  // Stopping is a pause with no resume promise: nothing is rolled back, and the
  // persisted record is what an explicit resume re-enters from.
  activeSessionMonitor?.stop();
  activeSessionMonitor = undefined;
  activeAutoRun?.interrupt("the extension is shutting down");
  await activeAutoRun?.settle();
  activeAutoRun = undefined;
  await persistence?.dispose();
  persistence = undefined;
  await bridge?.stop();
  bridge = undefined;
  // The published record names a port and a token that both die with the bridge.
  await commandEndpointRegistry?.clear().catch(() => undefined);
  commandEndpointRegistry = undefined;
}
