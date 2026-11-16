import type { ExtensionContext } from "vscode";
import { ProgressLocation, RelativePattern, Uri, commands, env, window, workspace } from "vscode";
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
import { createDelegationRoutes, delegationParentSession, providerSession, readDelegationBinding, resolveResumeBinding, resumeInOpenTerminal, type ManualDelegationLaunch } from "./bridge/manual-delegation.js";
import { FileCommandEndpointRegistry, commandEndpointDirectory } from "./bridge/command-endpoint.js";
import { TerminalController, type TerminalHandle } from "./platform/terminals.js";
import type { TerminalId } from "./domain/contracts.js";
import { initializeAgentLayout, createVsCodeTerminalHost, prepareAgentTerminalGroups } from "./vscode/terminals.js";
import { AgentWorkspaceFiles, WorkspaceRequestJournal, acquireWorkspaceOwner, acquireOrdinaryWorkspaceOwner, ownerRuntimeDirectory, type WorkspaceOwnerLease } from "./runtime/agent-workspace-owner.js";
import { WorkspaceBatchLauncher, presentWorkspaceBatchResult, validateWorkspaceLaunchPlan, type WorkspaceLaunchPlan, type WorkspaceLaunchProgress } from "./platform/workspace-launcher.js";
import { WorkspacePresetStore } from "./domain/workspace-presets.js";
import { NewWorkspaceLauncher } from "./vscode/workspace-launch.js";
import { ManualCheckouts } from "./platform/checkouts.js";
import { pickCheckout, prepareCheckout } from "./vscode/checkout-picker.js";
import { samePath } from "./git/worktree.js";
import { waitForIdleProviderStartup } from "./runtime/idle-startup.js";
import { WorkspaceStartup } from "./runtime/workspace-startup.js";
import { spawnCommandRunner } from "./platform/preflight.js";
import { ClaudeAgentPlatform } from "./claude/platform.js";
import { ChatGptAgentPlatform } from "./chatgpt/platform.js";
import { PiAgentPlatform } from "./pi/platform.js";
import { inspectPiSession } from "./pi/sessions.js";
import { requirePiSkill, requirePiWorkerSkills } from "./pi/skills.js";
import { ChatGptSessionProbe } from "./chatgpt/sessions.js";
import { claudeSessionTitle } from "./claude/sessions.js";
import { ChatGptHookTrust } from "./chatgpt/hook-trust.js";
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
import { AtomicJsonFile, FileActivityStore, FileFleetStore, PersistOnChange } from "./runtime/persistence.js";
import { ActivityRecorder } from "./runtime/activity-recorder.js";
import { isInteractiveLaunch, shouldRecordEndedSession, type AgentOutcome } from "./domain/activity.js";
import { completedCount } from "./domain/run-plan.js";
import { isLiveSession } from "./vscode/fleet.js";
import { discoverNativeSessions } from "./platform/native-sessions.js";
import { ReopenCoordinator, describeReopenOutcome } from "./platform/reopen.js";
import { registerReopenCommand } from "./vscode/reopen.js";
import { pickReopenSession } from "./vscode/reopen-picker.js";
import { combineHandlers } from "./bridge/router.js";
import { DelegationCoordinator, type DelegationConfigurationSource } from "./bridge/delegation.js";
import { WorkerHookService, createWorkerHookRoutes } from "./bridge/worker-hooks.js";
import { createPlatformLifecycleRoutes } from "./bridge/platform-lifecycle.js";
import { createAutoRoutes } from "./bridge/auto.js";

import { GitWorkingTreeInspector, WorkerLifecycleReconciler, reportsResult } from "./bridge/lifecycle.js";
import {
  SessionLifecycleService,
  SessionProcessMonitor,
  SessionStartupProofs,
  type SessionEndReason,
} from "./bridge/session-lifecycle.js";
import { lockMarkerDirectory, lockMarkerLive, sessionExitFailure, sessionLaunchFailure, sessionWrapperLayout, takeSessionExitRecord, watchLockMarkers, type SessionExitRecord } from "./runtime/lock-markers.js";
import { WorkspaceAgentIdCounter } from "./runtime/agent-id-counter.js";
import { PromptResolver } from "./platform/prompts.js";
import { GitHubDelegationPromptResolver } from "./github/prompt-adapter.js";
import { FileSystemPromptSpillStore, createPromptSpillRoot } from "./platform/spill.js";
import { readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isHeadlessExecution, type AgentId, type AgentSession, type AgentType, type IsoTimestamp, type SessionId, type TerminalId as TerminalIdBrand } from "./domain/contracts.js";


/** Generous worker proof-of-life window: cold starts include `uv` resolving the hook shim and the agent CLI boot. */
const STARTUP_PROOF_TIMEOUT_MS = 60_000;
const SESSION_LIVENESS_POLL_MS = 5_000;

import { CachingGitClient, ProcessGitClient, type GitClient } from "./git/client.js";
import { AboardBranchCleanup, ProcessAboardBranchRepository } from "./git/branch-cleanup.js";
import { registerBranchCleanupCommand } from "./vscode/branch-cleanup.js";
import { registerLaunchPanel } from "./vscode/launch-panel.js";
import { AutoRunEngine } from "./auto/engine.js";
import { closeSettledAutoRunTerminal } from "./auto/terminal-cleanup.js";
import { WorktreeRunWorkspaces } from "./auto/worktree.js";

import { FileAutoRunStore } from "./runtime/persistence.js";
import { RuntimeAdmission, RuntimeStartup } from "./runtime/admission.js";
import { RuntimeLayout } from "./runtime/layout.js";
import { requireHarnessSkill, requireHarnessWorkerSkills } from "./claude/skills.js";
import { requireChatGptSkill, requireChatGptWorkerSkills } from "./chatgpt/skills.js";
import { FileLaunchConfigurationSource } from "./platform/launch-configuration.js";
import { createGrillCloudRelay, type GrillCloudRelay } from "./grill/cloud-relay.js";
import { PromptSubmissions } from "./platform/prompt-submissions.js";

let bridge: BridgeRuntime | undefined;
let commandEndpointRegistry: FileCommandEndpointRegistry | undefined;
let delegationEndpointRegistry: FileCommandEndpointRegistry | undefined;
let persistence: PersistOnChange | undefined;
let activeAutoRun: AutoRunEngine | undefined;
let activeWorkspaceOwnership: WorkspaceOwnerLease | undefined;

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
  const requireSkills = async (configured: Awaited<ReturnType<FileLaunchConfigurationSource["get"]>>, type: AgentType, root = workspaceRoot) => {
    if (type === "address" || type === "review") {
      if (configured.platform === "claude") await requireHarnessWorkerSkills(root);
      else if (configured.platform === "chatgpt") await requireChatGptWorkerSkills(root);
      else if (configured.platform === "pi") await requirePiWorkerSkills(root);
    }
    return configured;
  };
  return {
    get: async (type) => requireSkills(await source.get(type), type),
    getFor: async (platform, type) => requireSkills(await source.getFor(platform, type), type),
    getDelegationFor: async (platform, task) => requireSkills(await source.getDelegationFor(platform, task), task === "explore" ? "explore" : "general"),
    getForWorktree: async (platform, type, cwd) => requireSkills(await source.getForWorktree(platform, type, cwd), type, cwd),
    getDelegationForWorktree: async (platform, task, cwd) => requireSkills(await source.getDelegationForWorktree(platform, task, cwd), task === "explore" ? "explore" : "general", cwd),
  };
}

/** Exposed so the VS Code integration suite can locate command discovery. */
export interface AboardExtensionApi {
  readonly agentWorkspaceStorageRoot: string;
  /** Where `/commands` publishes this window's port and command-scoped token. */
  readonly commandEndpointDirectory: string;
  readonly delegationEndpointDirectory: string;
}

export async function activate(context: ExtensionContext): Promise<AboardExtensionApi | undefined> {
  // Window-local UI and Auto Run use the first folder; delegated execution uses
  // the durable child's cwd within any explicitly opened folder.
  const workspaceRoots = workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const workspaceRoot = workspaceRoots[0];
  if (workspaceRoot === undefined) return undefined;
  const workspaceFiles = new AgentWorkspaceFiles(context.globalStorageUri.fsPath);
  let startupHandoff = workspace.workspaceFile?.scheme === "file" ? await workspaceFiles.read(workspace.workspaceFile.fsPath, workspaceRoot) : undefined;
  if (startupHandoff !== undefined) {
    const ownership = await acquireWorkspaceOwner(context.globalStorageUri.fsPath, startupHandoff.ownerId);
    if (ownership === undefined) startupHandoff = undefined;
    else activeWorkspaceOwnership = ownership;
  }
  const ordinaryOwnership = startupHandoff === undefined ? await acquireOrdinaryWorkspaceOwner(context.globalStorageUri.fsPath, workspaceRoot) : undefined;
  activeWorkspaceOwnership ??= ordinaryOwnership;
  const ownerId = startupHandoff?.ownerId ?? ordinaryOwnership!.ownerId;
  const workspaceStartup = startupHandoff === undefined ? undefined : new WorkspaceStartup(context.globalStorageUri.fsPath, startupHandoff);
  await workspaceStartup?.opened();
  const startupStatus = startupHandoff === undefined ? undefined : window.createStatusBarItem();
  if (startupStatus !== undefined) {
    startupStatus.text = "$(loading~spin) Starting agent workspace…";
    startupStatus.tooltip = "Aboard is preparing the workspace and starting its agents.";
    startupStatus.show();
    context.subscriptions.push(startupStatus);
  }
  const storageRoot = ownerRuntimeDirectory((context.storageUri ?? context.globalStorageUri).fsPath, ownerId);
  const runtime = new RuntimeLayout(storageRoot);
  const bridgeIdentityStore = new AtomicJsonFile<{ port: number; token: string }>(join(runtime.root, "bridge-identity.json"), (value) => {
    if (typeof value !== "object" || value === null || !("port" in value) || !("token" in value) || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || value.token.length < 16) return undefined;
    return { port: value.port, token: value.token };
  });
  const persistedBridgeIdentity = await bridgeIdentityStore.load();
  const workspaceJournal = new WorkspaceRequestJournal(join(storageRoot, "workspace-requests"));
  const workspaceInitializedKey = `aboard.agentWorkspaceInitialized:${ownerId}`;
  let agentWorkspaceInitialized = context.workspaceState.get<boolean>(workspaceInitializedKey) === true;
  let workspaceBatchActive = 0;

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
  const startupFailures = new Map<AgentId, string>();
  const scaffoldAssetRoot = join(context.extensionPath, "assets", "scaffold");
  const expectedScaffoldRevision = await scaffoldCatalogRevision(scaffoldAssetRoot);
  let scaffoldState = await readScaffoldState(workspaceRoot, expectedScaffoldRevision).catch(() => "uninitialized" as const);
  const initialized = true;
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
        ...(process.env.HARNESS_GRILL_URL === undefined ? {} : { HARNESS_GRILL_URL: process.env.HARNESS_GRILL_URL }),
        ...(process.env.HARNESS_GRILL_CODE === undefined ? {} : { HARNESS_GRILL_CODE: process.env.HARNESS_GRILL_CODE }),
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
  for (const native of window.terminals) {
    const options = native.creationOptions;
    if (!("env" in options) || options.env?.ABOARD_RUNTIME_ROOT !== runtime.root) continue;
    const agentId = options.env.ABOARD_AGENT_ID;
    const saved = agentId === undefined || agentId === null ? undefined : fleet.get(agentId as AgentId);
    if (saved !== undefined && isLiveSession(saved) && !isHeadlessExecution(saved.identity.type, saved.executionMode)) terminals.adopt(saved, native, saved.cwd ?? workspaceRoot);
  }
  // Presence belongs to this project, so the relay lives exactly as long as the
  // project is initialized: an uninitialized workspace neither reports nor polls.
  let grillRelay: GrillCloudRelay | undefined;
  // Tracked separately from the relay itself: an unconfigured host yields no
  // relay, and retrying that on every `.abd/` write would repeat its diagnostic.
  let grillRelayResolved = false;
  const promptSubmissions = new PromptSubmissions();
  const syncGrillRelay = (): void => {
    const enabled = scaffoldState === "ready";
    if (enabled === grillRelayResolved) return;
    grillRelayResolved = enabled;
    if (!enabled) { grillRelay?.dispose(); grillRelay = undefined; return; }
    grillRelay = createGrillCloudRelay({ fleet, terminals, workspaceRoot, prompts: promptSubmissions, log: (message) => output.appendLine(message) });
    grillRelay?.start();
    output.appendLine(grillRelay === undefined
      ? "Grill relay is inactive: configure a four-digit grill.code in .harness/config.local.json or ~/.harness/config.json, or this VS Code process's HARNESS_GRILL_CODE. The board defaults to https://grill-me-in-cloud.vercel.app; grill.url is an optional override. After configuring it, reload the window."
      : `Grill relay started for this project as instance ${grillRelay.instanceId}.`);
  };
  context.subscriptions.push({ dispose: () => grillRelay?.dispose() });
  const delegationStateDirectory = join(runtime.root, "delegations");
  const parentTerminalUri = async (childSessionId: string, parentSessionId?: string, runtime?: ManualDelegationLaunch): Promise<string | undefined> => {
    try {
      if (parentSessionId !== undefined) parentSessionId = await providerSession(delegationStateDirectory, parentSessionId, runtime);
      const target = Uri.from({
        scheme: env.uriScheme,
        authority: context.extension.id,
        path: "/focus-parent",
        query: new URLSearchParams({ childSessionId, ...(parentSessionId === undefined ? {} : { parentSessionId }) }).toString(),
      });
      return (await env.asExternalUri(target)).toString();
    } catch (error) {
      output.appendLine(`Could not create the parent-terminal link: ${error instanceof Error ? error.message : "unknown error"}`);
      return undefined;
    }
  };
  context.subscriptions.push(window.registerUriHandler({
    handleUri: async (uri) => {
      if (uri.path !== "/focus-parent") return;
      const parameters = new URLSearchParams(uri.query);
      const childSessionId = parameters.get("childSessionId");
      // asExternalUri may append its own window-routing query parameters.
      if (childSessionId === null || !childSessionId.trim()) {
        void window.showWarningMessage("That Aboard terminal link is invalid.");
        return;
      }
      const parentSessionId = await delegationParentSession(delegationStateDirectory, childSessionId).catch(() => undefined)
        ?? parameters.get("parentSessionId") ?? undefined;
      const parent = parentSessionId === undefined ? undefined : fleet.getBySession(parentSessionId as SessionId);
      const terminalId = parent === undefined ? undefined : terminals.liveTerminalForAgent(parent.identity.agentId);
      if (terminalId === undefined) {
        void window.showInformationMessage("The parent agent terminal is no longer open.");
        return;
      }
      terminals.show(terminalId);
    },
  }));
  // A visible child opens as a tab beside its parent agent rather than in
  // whichever editor group the user happens to be working in.
  const parentEditorPane = async (parentSessionId: string | undefined, runtime?: ManualDelegationLaunch): Promise<{ readonly editorPane?: object }> => {
    if (parentSessionId === undefined) return {};
    const sessionId = await providerSession(delegationStateDirectory, parentSessionId, runtime).catch(() => parentSessionId);
    const parent = fleet.getBySession(sessionId as SessionId);
    const terminalId = parent === undefined ? undefined : terminals.liveTerminalForAgent(parent.identity.agentId);
    const editorPane = terminalId === undefined ? undefined : await terminals.editorPaneOf(terminalId).catch(() => undefined);
    return editorPane === undefined ? {} : { editorPane };
  };
  const activityListeners = new Set<() => void>();
  const activity = new ActivityRecorder({
    store: new FileActivityStore(runtime.root, runtimeAdmission),
    admission: () => initialized,
    now: () => new Date(),
    log: (message) => output.appendLine(message),
    onDidChange: () => { for (const listener of activityListeners) listener(); },
  });
  const launchFile = new FileLaunchConfigurationSource({
    project: join(workspaceRoot, ".harness", "config.json"),
    global: join(homedir(), ".harness", "config.json"),
  });
  const claudePlatform = new ClaudeAgentPlatform({
    commandRunner: spawnCommandRunner(workspaceRoot),
    lifecycleAssets: {
      settings: join(context.extensionPath, "assets", "runtime", "abd-hooks.json"),
      script: join(context.extensionPath, "assets", "runtime", "abd_hook.py"),
    },
  });
  const hookTrustKey = `aboard.codexHooksAllowed:${workspaceRoot}`;
  const chatGptHookTrust = new ChatGptHookTrust({
    isAllowed: () => context.workspaceState.get<boolean>(hookTrustKey) === true,
    remember: async () => { await context.workspaceState.update(hookTrustKey, true); },
    ask: async () => await window.showWarningMessage(
      "Allow configured Codex hooks for Aboard sessions in this workspace?",
      { modal: true, detail: "Aboard needs lifecycle hooks to detect session startup, and guard hooks for Auto Run. This allows all enabled Codex hooks, including user and project hooks, without individual trust review during Aboard launches and resumes. Only allow this if you trust those hooks. Your choice is remembered for this workspace." },
      "Allow Hooks",
    ) === "Allow Hooks",
  });
  const chatGptPlatform = new ChatGptAgentPlatform({
    approveHooks: () => chatGptHookTrust.approve(),
    commandRunner: spawnCommandRunner(workspaceRoot),
    lifecycleAssets: {
      settings: join(context.extensionPath, "assets", "runtime", "abd-hooks.json"),
      script: join(context.extensionPath, "assets", "runtime", "abd_hook.py"),
    },
  });
  const platforms: ReadonlyMap<AgentPlatformId, AgentPlatform> = new Map<AgentPlatformId, AgentPlatform>([
    [claudePlatform.id, claudePlatform],
    [chatGptPlatform.id, chatGptPlatform],
    ["pi", new PiAgentPlatform({ commandRunner: spawnCommandRunner(workspaceRoot), lifecycleAssets: { settings: join(context.extensionPath, "assets", "runtime", "abd_pi.ts"), script: join(context.extensionPath, "assets", "runtime", "abd_hook.py") } })],
  ]);

  const sessionIsResumable = async (platformId: AgentSession["platform"], sessionId: SessionId, cwd: string, type?: AgentSession["identity"]["type"]): Promise<boolean> => {
    const platform = platforms.get(platformId);
    if (platform === undefined) return false;
    if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) throw new Error(`The session's checkout is missing: ${cwd}. Restore it before reopening this session.`);
    const configured = type === undefined ? undefined : await launchFile.getForWorktree(platformId, type, cwd).catch(() => undefined);
    const settings = configured?.platform === platformId ? configured.settings : undefined;
    const command = typeof settings === "object" && settings !== null && "declaredCommand" in settings
      ? (settings as { readonly declaredCommand?: readonly string[] }).declaredCommand
      : undefined;
    return platform.isResumable(sessionId, cwd, command);
  };
  const titleProbe = new ChatGptSessionProbe();
  const readSessionTitle = async (entry: { readonly platform: AgentPlatformId; readonly sessionId: SessionId; readonly cwd?: string; readonly type: AgentSession["identity"]["type"] }): Promise<string | undefined> => {
    const { platform, sessionId } = entry;
    const cwd = entry.cwd ?? workspaceRoot;
    if (platform === "claude") return claudeSessionTitle(sessionId, cwd);
    const configured = await launchFile.getForWorktree(platform, entry.type, cwd).catch(() => undefined);
    const settings = configured?.platform === platform ? configured.settings : undefined;
    const command = typeof settings === "object" && settings !== null && "declaredCommand" in settings
      ? (settings as { readonly declaredCommand?: readonly string[] }).declaredCommand : undefined;
    return platform === "pi"
      ? (await inspectPiSession(sessionId, cwd, command))?.title
      : titleProbe.title(sessionId, cwd, command);
  };
  const readActivityTitles = async (includeHistory: boolean): Promise<void> => {
    const candidates = new Map((includeHistory ? activity.entries() : []).flatMap((entry) => entry.kind !== "agent" || entry.reopen === undefined ? [] : [[entry.reopen.sessionId, {
      ...entry.reopen, type: entry.type,
    }] as const]));
    for (const session of fleet.list()) {
      if (terminals.liveTerminalForAgent(session.identity.agentId) !== undefined) candidates.set(session.sessionId, {
        platform: session.platform, sessionId: session.sessionId, cwd: session.cwd ?? workspaceRoot, type: session.identity.type,
      });
    }
    await Promise.allSettled([...candidates.values()].map(async (entry) => {
      const title = await readSessionTitle(entry);
      if (title !== undefined) {
        fleet.setTitle(entry.sessionId, title, new Date().toISOString() as IsoTimestamp);
        activity.setTitle(entry.sessionId, title);
        terminals.setSessionTitle(entry.sessionId, title);
      }
    }));
  };
  let refreshingTitles: Promise<void> | undefined;
  const refreshActivityTitles = async (includeHistory = true): Promise<void> => {
    if (!initialized) return;
    if (refreshingTitles !== undefined) {
      if (!includeHistory) return;
      await refreshingTitles;
      return refreshActivityTitles(includeHistory);
    }
    const refresh = readActivityTitles(includeHistory);
    refreshingTitles = refresh;
    try { await refresh; }
    finally { refreshingTitles = undefined; }
  };
  const titleTimer = setInterval(() => { void refreshActivityTitles(false); }, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(titleTimer) });
  if (initialized) await activity.load().catch((error: unknown) => output.appendLine(`Activity store could not be read: ${error instanceof Error ? error.message : "unknown error"}`));
  if (initialized) void refreshActivityTitles();
  const rememberEndedSession = async (
    session: AgentSession,
    endedAt: IsoTimestamp,
    outcome: AgentOutcome = "ended",
    reason?: string,
  ): Promise<void> => {
    if (!initialized) return;
    // Capture this before the async transcript read: process-end settlement may
    // release the still-open terminal while the check is in flight.
    const terminalId = terminals.liveTerminalForAgent(session.identity.agentId);
    const conversationStarted = await sessionIsResumable(session.platform, session.sessionId, session.cwd ?? workspaceRoot, session.identity.type)
      .catch((error: unknown) => {
        output.appendLine(`Could not inspect ended agent ${session.identity.agentId}: ${error instanceof Error ? error.message : "unknown platform error"}`);
        return session.title !== undefined;
      });
    if (!shouldRecordEndedSession(session, conversationStarted)) {
      output.appendLine(`Discarded empty session for agent ${session.identity.agentId}; no agent conversation started.`);
      return;
    }
    const classified = isInteractiveLaunch(session) ? outcome : outcome === "ended" ? "succeeded" : outcome;
    const title = conversationStarted ? await readSessionTitle({ platform: session.platform, sessionId: session.sessionId,
      cwd: session.cwd ?? workspaceRoot, type: session.identity.type }).catch(() => session.title) : undefined;
    activity.recordAgent(title === undefined ? session : { ...session, title }, classified, endedAt, {
      conversationStarted,
      ...(reason === undefined ? {} : { reason }),
      ...(terminalId === undefined ? {} : { terminalId }),
    });
    void refreshActivityTitles();
  };
  const github = new GitHubClient(new ProcessGhExecutor(workspaceRoot));
  const knownAgentIds = (): string[] => [
    ...fleet.list().map((session) => session.identity.agentId as string),
    ...activity.entries().filter((entry) => entry.kind === "agent").map((entry) => entry.agentId as string),
  ];
  let agentIdCounter = WorkspaceAgentIdCounter.load(runtime.root, knownAgentIds, runtimeAdmission.isOpen, storageRoot);
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
      launchFileNotice = notice.length === 0 ? undefined : notice;
    } catch (error) {
      const notice = error instanceof Error ? error.message : "Invalid .harness/config.json";
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
  const settleFailedStartup = async (agentId: AgentId, error: unknown): Promise<unknown> => {
    const failure = startupFailures.get(agentId);
    startupFailures.delete(agentId);
    if (failure !== undefined) return new Error(failure);
    if (!(error instanceof Error) || error.name !== "SessionStartTimeoutError") return error;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (terminals.liveTerminalForAgent(agentId) === undefined && !lockMarkerLive(wrapperLayout.lockPathFor(agentId))) return error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return Object.assign(new Error("The original agent has not confirmed shutdown after its startup timeout. Inspect its owner before retrying."), { retrySafe: false });
  };
  const coordinator = new DelegationCoordinator({ settleFailedStartup, admission: () => initialized, workspaceRoot, promptRoot, fleet, lease, terminals, sessions: { observe: (agentId) => sessionMonitor.observe(agentId) }, onStaleLeaseRecovered: (holder, observation) => { output.appendLine(`Reclaimed the write lease from ${holder.agentId} (held since ${holder.acquiredAt}): terminal ${observation.terminal}, session ${observation.session}.`); void window.showWarningMessage(`aboard reclaimed the write lease from ${holder.agentId}: its terminal and session are both gone.`); }, configurations: launchConfigurations, platforms, prompts: new GitHubDelegationPromptResolver(new PromptResolver({ github })), spills: runtimeFiles, shell: process.platform === "win32" ? "powershell" : "git-bash", maxInlinePromptChars: currentConfiguration.maxInlinePromptChars, agentIdFactory: () => agentIdCounter.next(), startupTimeoutMs: STARTUP_PROOF_TIMEOUT_MS, awaitIdleStartup: (agentId, terminalId) => waitForIdleProviderStartup(wrapperLayout.lockPathFor(agentId), () => terminals.list().some((terminal) => terminal.terminalId === terminalId && terminal.status === "open"), STARTUP_PROOF_TIMEOUT_MS), wrapper: wrapperLayout, lockProbe: lockMarkerLive });
  lifecycle = new WorkerLifecycleReconciler({
    fleet,
    lease,
    completions: coordinator,
    workingTree: new GitWorkingTreeInspector(),
    onFinished: (session, result) => {
      if (!initialized) return;
      const at = new Date().toISOString() as IsoTimestamp;
      void rememberEndedSession(
        session,
        at,
        result.outcome === "succeeded" ? "succeeded" : result.failure.type === "killed" ? "cancelled" : "failed",
        result.outcome === "failed" ? result.failure.type : undefined,
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
    startupFailures.set(agentId, `The configured agent command ${cause}`);
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
      if (initialized) activity.recordAgent(failed, "launch-failed", at, { reason: cause, conversationStarted: false });
      fleet.remove(agentId, at);
    }
    releaseAbandonedTerminal(agentId);
    if (workspaceBatchActive === 0) void window.showWarningMessage(`aboard could not start the configured agent: it ${cause}. Check the terminal for the error.`);
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
  const mainCheckoutRoot = (await git.worktrees())[0]?.path ?? workspaceRoot;
  const autoRun = new AutoRunEngine({
    git,
    gitFor: (cwd) => new CachingGitClient(new ProcessGitClient(cwd)),
    workspaceRoot,
    // Where a run works. In its own checkout beside the project when the user
    // asked for one, in their files otherwise.
    workspaces: new WorktreeRunWorkspaces({
      workspaceRoot,
      mainCheckoutRoot,
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
    allocateAgentId: () => agentIdCounter.next(),
    discover: (publish, signal) => discoverNativeSessions({
      ...(publish ? { publish } : {}),
      ...(signal ? { signal } : {}),
      cwd: workspaceRoot,
      command: async (platform, cwd) => {
        const configured = await launchFile.getForWorktree(platform, "interactive", cwd);
        const settings = configured.settings;
        return typeof settings === "object" && settings !== null && "declaredCommand" in settings
          ? (settings as { readonly declaredCommand?: readonly string[] }).declaredCommand : undefined;
      },
      log: (message) => output.appendLine(message),
    }),
    activity: { entries: () => activity.store() },
    fleet,
    terminals: {
      isOpen: (terminalId) => terminals.list().some((terminal) => terminal.terminalId === terminalId && terminal.status === "open"),
      liveTerminalFor: (agentId) => terminals.liveTerminalForAgent(agentId),
      show: (terminalId) => terminals.show(terminalId),
    },
    launcher: { reopen: (target) => coordinator.reopen(target) },
    isResumable: (platform, sessionId, cwd, type) => sessionIsResumable(platform, sessionId, cwd ?? workspaceRoot, type),
  });
  const commandEndpoint = new FileCommandEndpointRegistry({ directory: commandEndpointDirectory(process.platform, process.env, homedir()) });
  const delegationEndpoint = new FileCommandEndpointRegistry({ directory: join(homedir(), ".harness", "backends", "endpoints") });
  delegationEndpointRegistry = delegationEndpoint;
  context.subscriptions.push({ dispose: () => void delegationEndpoint.clear() });
  await commandEndpoint.clearWorkspace(workspaceRoot).catch(() => undefined);
  commandEndpointRegistry = commandEndpoint;
  context.subscriptions.push({ dispose: () => void commandEndpoint.clear() });
  const providerChoices = [...platforms.values()].map((platform) => ({ id: platform.id, displayName: platform.displayName ?? platform.id, icon: platform.icon ?? "terminal" }));
  const presetStore = new WorkspacePresetStore(context.globalState, providerChoices.map((provider) => provider.id), (message) => output.appendLine(`Presets: ${message}`));
  const shellTerminals = new Map<string, TerminalHandle>();
  const shellHost = createVsCodeTerminalHost();
  context.subscriptions.push(shellHost.onDidCloseTerminal((terminal) => {
    for (const [id, handle] of shellTerminals) if (handle === terminal) shellTerminals.delete(id);
  }));
  const checkouts = new ManualCheckouts({
    workspaceRoot, storageRoot: context.globalStorageUri.fsPath,
    settings: () => currentConfiguration.autoRun.worktree,
    reserved: (path) => autoRun.isActive() && samePath(path, autoRun.persisted()?.settings.workspaceRoot ?? workspaceRoot),
    activeAgents: (path) => fleet.list().filter((session) => isLiveSession(session) && samePath(session.cwd ?? workspaceRoot, path)).length,
    log: (message) => output.appendLine(message),
  });
  const batchLauncher = new WorkspaceBatchLauncher({
    providers: providerChoices.map((provider) => provider.id),
    initialized: () => agentWorkspaceInitialized,
    markInitialized: async () => {
      await context.workspaceState.update(workspaceInitializedKey, true);
      agentWorkspaceInitialized = true;
    },
    initializeLayout: initializeAgentLayout,
    launch: async (provider, editorPane, onCreated, checkoutRoot = workspaceRoot) => {
      if (provider === "") {
        const terminalId = randomUUID();
        const terminal = shellHost.createTerminal({ cwd: checkoutRoot, env: {}, editorPane: editorPane ?? window.tabGroups.activeTabGroup });
        shellTerminals.set(terminalId, terminal);
        onCreated();
        return { terminalId };
      }
      return coordinator.launchInteractive({
        type: "interactive", description: `${provider} interactive`, focus: false,
        ...(editorPane === undefined ? {} : { editorPane }),
        configuration: await launchFile.getForWorktree(provider as AgentPlatformId, "interactive", checkoutRoot),
        isolation: { cwd: checkoutRoot, protectedPaths: [], writableRoots: [] },
      }, "user", onCreated);
    },
    focus: (terminalId) => {
      try {
        const shell = shellTerminals.get(terminalId);
        if (shell) shell.show(false); else terminals.show(terminalId as TerminalId);
      } catch { /* user closed it while the batch completed */ }
    },
  });
  const launchLocal = async (plan: WorkspaceLaunchPlan, onProgress?: (progress: WorkspaceLaunchProgress) => void, destination: "current" | "new" = "new") => {
    if (!initialized) throw new Error("Initialize this project before launching an agent workspace");
    workspaceBatchActive++;
    try {
      await prepareAgentTerminalGroups();
      return await (destination === "new" ? batchLauncher.launch(plan, onProgress) : batchLauncher.launchCurrent(plan, onProgress));
    }
    finally { workspaceBatchActive--; }
  };
  const workspaceLauncher = new NewWorkspaceLauncher({ projectRoot: workspaceRoot, storageRoot: context.globalStorageUri.fsPath, providers: providerChoices.map((provider) => provider.id), files: workspaceFiles, log: (message) => output.appendLine(message) });
  const bridgeStartup = new RuntimeStartup(runtimeAdmission);
  const startRuntimeBridge = (): Promise<void> => {
    if (!initialized || bridge !== undefined) return Promise.resolve();
    return bridgeStartup.run(async () => {
    if (!initialized || bridge !== undefined) return;
    const workerHooks = new WorkerHookService(fleet, runtimeFiles);
    bridge = await startBridge({
    preferredPort: persistedBridgeIdentity?.port ?? currentConfiguration.bridgePort,
    ...(persistedBridgeIdentity === undefined ? {} : { tokenFactory: () => persistedBridgeIdentity.token }),
    handler: combineHandlers(
      createAutoRoutes({
        dryRun: (options) => autoRun.dryRun(options),
        start: async (options) => {
          if ((await launchFile.load()).value.autoRunProvider === "chatgpt" && !await chatGptHookTrust.approve()) {
            return { started: false as const, reason: "Codex Auto Run requires workspace hook consent" };
          }
          return autoRun.start(options);
        },
      }),
      createPlatformLifecycleRoutes({ fleet, platforms, sessions: sessionLifecycle, workers: lifecycle, compactions: workerHooks, sessionBindings: [lease, terminals], proofs: sessionProofs, prompts: promptSubmissions }),
      createWorkerHookRoutes(workerHooks),
      createTerminalRoutes(terminals),
      createCommandRoutes(commandTerminals),
      createDelegationRoutes({ launch: async (request) => {
        if (request.skill !== undefined) {
          if (request.provider === "claude") await requireHarnessSkill(request.cwd, request.skill);
          else if (request.provider === "chatgpt") await requireChatGptSkill(request.cwd, request.skill);
          else await requirePiSkill(request.cwd, request.skill);
        }
        const configured = await launchFile.getDelegationForWorktree(request.provider, request.task, request.cwd);
        const returnUri = request.executionMode !== "auto" && request.harnessSessionId !== undefined
          ? await parentTerminalUri(request.harnessSessionId, request.parentSessionId, request)
          : undefined;
        return coordinator.launchManual({
          ...(request.executionMode === "auto" ? {} : await parentEditorPane(request.parentSessionId, request)),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
          ...(request.model === undefined ? {} : { model: request.model }),
          requestId: request.requestId,
          ...(request.harnessStateDirectory === undefined ? {} : { harnessStateDirectory: request.harnessStateDirectory }),
          ...(request.harnessRuntimePath === undefined ? {} : { harnessRuntimePath: request.harnessRuntimePath }),
          ...(request.harnessPython === undefined ? {} : { harnessPython: request.harnessPython }),
          ...(request.harnessSessionId === undefined ? {} : { harnessSessionId: request.harnessSessionId }),
          ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
          ...(returnUri === undefined ? {} : { parentTerminalUri: returnUri }),
          type: request.type,
          prompt: request.prompt,
          ...(request.skill === undefined ? {} : { skill: request.skill }),
          description: request.description,
          isolation: { cwd: request.cwd, protectedPaths: [], writableRoots: [] },
          executionMode: request.executionMode,
          ...(request.difficulty === undefined ? {} : { difficulty: request.difficulty }),
          configuration: configured,
        }, request.executionMode);
      }, resume: async (request) => {
        if (!request.harnessSessionId) throw new Error("Delegated resume requires its stable Harness identity");
        const local = await readDelegationBinding(join(runtime.root, "delegations"), request.harnessSessionId);
        const binding = await resolveResumeBinding(request, local, () => agentIdCounter.next());
        const saved = fleet.get(binding.agentId as AgentId);
        const returnUri = binding.executionMode === "interactive"
          ? await parentTerminalUri(request.harnessSessionId, binding.parentSessionId, request)
          : undefined;
        const lockPath = wrapperLayout.lockPathFor(binding.agentId as AgentId);
        if (binding.resumeAction === "reuse-terminal" || (binding.resumeAction === "fork" && currentConfiguration.interactiveResumeMode === "reuse-terminal")) {
          const reused = await resumeInOpenTerminal(request, binding, saved, terminals, async (terminalId) => {
            if (!request.executionId || !request.harnessPython || !request.harnessRuntimePath || !request.harnessStateDirectory) throw new Error("Harness runtime identity is unavailable; resume refused");
            await promisify(execFile)(request.harnessPython, ["-m", "subagents_runtime.terminal_resume", request.harnessSessionId as string, request.executionId, binding.agentId, terminalId, binding.sessionId], {
              cwd: binding.cwd,
              env: { ...process.env, HARNESS_STATE_DIR: request.harnessStateDirectory, PYTHONPATH: [request.harnessRuntimePath, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
              windowsHide: true,
              timeout: 15_000,
            });
            if (!lockMarkerLive(lockPath)) throw new Error("Delegated session ended before the resume message could be submitted");
          });
          if (reused !== undefined) return reused;
          if (binding.resumeAction === "reuse-terminal") throw new Error("The runtime permits only the existing live terminal; reopening is refused");
        }
        if (binding.resumeAction === "fork" && request.forkSessionId !== undefined) {
          const configured = await launchFile.getDelegationForWorktree(binding.provider, binding.task, binding.cwd);
          return coordinator.launchManual({
            ...(binding.executionMode === "auto" ? {} : await parentEditorPane(binding.parentSessionId, request)),
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            ...(request.model === undefined ? {} : { model: request.model }),
            forkSessionId: request.forkSessionId as SessionId,
            requestId: request.requestId,
            harnessSessionId: request.harnessSessionId,
            ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
            ...(returnUri === undefined ? {} : { parentTerminalUri: returnUri }),
            ...(request.harnessStateDirectory === undefined ? {} : { harnessStateDirectory: request.harnessStateDirectory }),
            ...(request.harnessRuntimePath === undefined ? {} : { harnessRuntimePath: request.harnessRuntimePath }),
            ...(request.harnessPython === undefined ? {} : { harnessPython: request.harnessPython }),
            type: binding.type, prompt: request.prompt, description: binding.description,
            isolation: { cwd: binding.cwd, protectedPaths: [], writableRoots: [] },
            executionMode: binding.executionMode, configuration: configured,
          }, binding.executionMode);
        }
        if (lockMarkerLive(lockPath)) throw new Error("Delegated execution is running or uncertain; resume refused");
        return coordinator.reopen({
          ...(binding.executionMode === "auto" ? {} : await parentEditorPane(binding.parentSessionId, request)),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
          ...(request.model === undefined ? {} : { model: request.model }),
          platform: binding.provider, agentId: binding.agentId as AgentId, type: binding.type,
          delegationTask: binding.task, sessionId: binding.sessionId as SessionId,
          executionMode: binding.executionMode, cwd: binding.cwd, prompt: request.prompt,
          resultDelivery: saved?.resultDelivery ?? { mode: "none" },
          harnessSessionId: request.harnessSessionId, requestId: request.requestId,
          ...(request.difficulty === undefined ? {} : { difficulty: request.difficulty }),
          ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
          ...(returnUri === undefined ? {} : { parentTerminalUri: returnUri }),
          ...(request.harnessStateDirectory === undefined ? {} : { harnessStateDirectory: request.harnessStateDirectory }),
          ...(request.harnessRuntimePath === undefined ? {} : { harnessRuntimePath: request.harnessRuntimePath }),
          ...(request.harnessPython === undefined ? {} : { harnessPython: request.harnessPython }),
        });
      } }, {
        workspaceRoot,
        workspaceRoots,
        stateDirectory: delegationStateDirectory,
      }),
    ),
    logger: { info: (message) => output.appendLine(message), error: (message) => output.appendLine(`Error: ${message}`) },
    });
    bridgeEnvironment = { port: bridge.port, token: bridge.token };
    await bridgeIdentityStore.save(bridgeEnvironment);
    if (persistedBridgeIdentity !== undefined && persistedBridgeIdentity.port !== bridge.port) output.appendLine("The previous owner bridge port is occupied. Existing terminal controls remain available, but their lifecycle hooks require the original port; new sessions use the current bridge.");
    try {
    const endpointRecord = {
      version: 2,
      host: bridge.host,
      port: bridge.port,
      workspaceRoot,
      commandToken: bridge.commandToken,
      delegationToken: bridge.delegationToken,
      workspaceRoots,
      pid: process.pid,
      activatedAt: new Date().toISOString(),
    } as const;
    const published = await commandEndpoint.publish(endpointRecord);
    const { commandToken: _commandToken, ...delegationRecord } = endpointRecord;
    await delegationEndpoint.publish(delegationRecord);
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
    if ((await launchFile.load()).value.autoRunProvider === "chatgpt" && !await chatGptHookTrust.approve()) {
      return { started: false as const, reason: "Codex Auto Run requires workspace hook consent" };
    }
    return autoRun.startPreviewed(preview);
  };
  fleetUi = registerNativeFleetUi(context, {
    suppressLaunchNotifications: () => workspaceBatchActive > 0,
    runtimeRoot: runtime.root,
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
  const runAgentOn = async (provider: AgentPlatformId, warn: (message: string) => void = (message) => { void window.showWarningMessage(message); }): Promise<void> => {
    if (!requireInitialized()) return;
    workspaceBatchActive++;
    try {
      const selection = await pickCheckout(checkouts, workspaceRoot);
      if (!selection) return;
      // Validate the source provider before creation; the target's authority is read again after setup.
      await launchFile.getForWorktree(provider, "interactive", selection.kind === "existing" ? selection.path : workspaceRoot);
      const checkoutRoot = await prepareCheckout(checkouts, selection, (message) => output.appendLine(message), () => output.show());
      if (!checkoutRoot) return;
      await window.withProgress({ location: ProgressLocation.Window, title: "Starting agent", cancellable: false }, async () => {
        await prepareAgentTerminalGroups();
        await coordinator.launchInteractive({
          type: "interactive", description: `${provider} interactive`,
          configuration: await launchFile.getForWorktree(provider, "interactive", checkoutRoot),
          isolation: { cwd: checkoutRoot, protectedPaths: [], writableRoots: [] },
        }, "user");
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "SessionStartCancelledError")) {
        warn(error instanceof Error ? error.message : "Unable to start the agent");
      }
    } finally { workspaceBatchActive--; }
  };
  const runAgent = async (warn?: (message: string) => void): Promise<void> => {
    if (!requireInitialized()) return;
    const selected = await window.showQuickPick(providerChoices.map((provider) => ({ label: `$(${provider.icon}) ${provider.displayName}`, provider: provider.id })), { placeHolder: "Choose the provider for this agent" });
    if (selected !== undefined) await runAgentOn(selected.provider, warn);
  };
  const reconcileStaleSessions = (): void => {
    const openTerminalIds = new Set(terminals.list().filter((terminal) => terminal.status === "open").map((terminal) => terminal.terminalId));
    for (const session of fleet.list()) {
      if (isLiveSession(session) && openTerminalIds.has(session.terminal.terminalId)) sessionMonitor.track({ agentId: session.identity.agentId, sessionId: session.sessionId, lockFile: wrapperLayout.lockPathFor(session.identity.agentId) });
    }
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
    scaffoldState = await readScaffoldState(workspaceRoot, expectedScaffoldRevision).catch(() => "uninitialized" as const);
    // Optional project assets never control the lifetime of terminals or runtime services.
    await startRuntimeBridge();
    syncGrillRelay();
    await commands.executeCommand("setContext", "aboard.initialized", initialized);
    await commands.executeCommand("setContext", "aboard.scaffoldUpdateRequired", scaffoldState === "update-required");
    if (scaffoldState !== "update-required") scaffoldUpdateWarningShown = false;
    if (scaffoldState === "update-required" && !scaffoldUpdateWarningShown) {
      scaffoldUpdateWarningShown = true;
      void window.showWarningMessage("aboard's optional project assets were created by another extension version. You can update them with Update Project.");
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
    window.onDidChangeWindowState((state) => { if (state.focused) void publishScaffoldState().then(() => refreshActivityTitles()); }),
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
    commands.registerCommand("aboard.openAgentCheckout", async (node: unknown) => {
      const selected = node as { session?: AgentSession; entry?: { kind?: string; reopen?: { cwd?: string } } } | undefined;
      const path = selected?.session?.cwd ?? selected?.entry?.reopen?.cwd ?? workspaceRoot;
      if (!(await stat(path).catch(() => undefined))?.isDirectory()) {
        void window.showErrorMessage(`The checkout is missing: ${path}`);
        return;
      }
      await commands.executeCommand("vscode.openFolder", Uri.file(path), { forceNewWindow: true });
    }),
    commands.registerCommand("aboard.runAgent", () => runAgent()),
    commands.registerCommand("aboard.launchWorkspace", () => commands.executeCommand("aboard.launch.focus")),
    commands.registerCommand("aboard.runClaudeCode", () => runAgentOn("claude")),
    commands.registerCommand("aboard.runCodex", () => runAgentOn("chatgpt")),
    commands.registerCommand("aboard.runPi", () => runAgentOn("pi")),
    registerLaunchPanel({ registerWebviewViewProvider: (viewId, provider) => window.registerWebviewViewProvider(viewId, provider) }, {
      store: presetStore, providers: providerChoices,
      currentPath: workspaceRoot,
      checkoutChoices: () => checkouts.choices(),
      validateBranch: async (branch) => {
        await new ProcessGitClient(workspaceRoot).validateBranchName(branch);
        return undefined;
      },
      launch: async (request) => {
        if (!requireInitialized()) return;
        // Reject invalid profiles before creating a checkout or opening another window.
        for (const provider of new Set(request.preset.panes.flatMap((pane) => pane.providers).filter(Boolean))) await launchFile.getForWorktree(provider as AgentPlatformId, "interactive", request.checkout?.kind === "existing" ? request.checkout.path : workspaceRoot);
        let selection = request.checkout ?? { kind: "current" as const };
        if (selection.kind === "new" && !selection.useExistingBranch && await checkouts.branchExists(selection.branch)) {
          const answer = await window.showWarningMessage(`Branch ${selection.branch} already exists. Create a worktree using that branch?`, { modal: true }, "Use existing branch");
          if (!answer) return;
          selection = { ...selection, useExistingBranch: true };
        }
        const checkoutRoot = await prepareCheckout(checkouts, selection, (message) => output.appendLine(message), () => output.show());
        if (!checkoutRoot) return;
        if (request.destination === "new") {
          await workspaceLauncher.launch(request, checkoutRoot);
          return;
        }
        await window.withProgress({ location: ProgressLocation.Window, title: "Starting terminals in current window", cancellable: false }, async (progress) => {
          const result = await launchLocal(validateWorkspaceLaunchPlan({ preset: request.preset, empty: false, manual: true, checkoutRoot }, providerChoices.map((provider) => provider.id)), (state) => {
            progress.report({ message: `${state.started} of ${state.total} terminals ready${state.failed > 0 ? `, ${state.failed} failed` : ""}` });
          }, "current");
          for (const failure of result.failed) output.appendLine(`Current window launch: ${failure.provider}: ${failure.message}`);
          await presentWorkspaceBatchResult(result, async (message) => { throw new Error(message); });
        });
      },
      runAgent,
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
      registerCommand: (command, callback) => commands.registerCommand(command, async (...args) => {
        if (!requireInitialized()) return;
        return callback(...args);
      }),
      // `matchOnDetail` so "ended", or an age, filters the list, which is how a
      // user with a long history finds the one they mean.
      pick: (items, placeholder, load) => pickReopenSession(
        window.createQuickPick(), items, placeholder, load, (message) => output.appendLine(message),
      ),
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
  if (startupHandoff !== undefined && initialized && workspaceStartup !== undefined) {
    const handoff = startupHandoff;
    // The owner remains autonomous if its source closes. The durable claim prevents replay on reload.
    void Promise.resolve(window.withProgress({ location: ProgressLocation.Window, title: "Starting workspace terminals", cancellable: false }, async (progress) => {
      progress.report({ message: "Preparing the terminal layout…" });
      let completed = 0;
      return workspaceStartup.execute(() => workspaceJournal.execute(handoff.requestId, () => launchLocal(validateWorkspaceLaunchPlan(handoff.plan, providerChoices.map((provider) => provider.id)), (state) => {
        const message = `${state.started} of ${state.total} terminals ready${state.failed > 0 ? `, ${state.failed} failed` : ""}`;
        progress.report({ message, increment: state.total === 0 ? 0 : (state.started + state.failed - completed) / state.total * 100 });
        completed = state.started + state.failed;
        if (startupStatus !== undefined) startupStatus.text = `$(loading~spin) ${message}`;
      }), handoff.plan));
    })).catch((error: unknown) => output.appendLine(`Workspace handoff: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => startupStatus?.dispose());
  } else {
    startupStatus?.dispose();
    if (workspaceStartup !== undefined && !initialized) {
      const message = "This checkout needs Aboard initialization or an update. Prepare it in this window, then launch the layout again.";
      void workspaceStartup.execute(async () => ({ started: 0, cancelled: 0, failed: [{ provider: "workspace", message }] })).catch((error: unknown) => output.appendLine(`Workspace handoff: ${error instanceof Error ? error.message : String(error)}`));
      void window.showErrorMessage(message);
    }
  }
  return { commandEndpointDirectory: commandEndpoint.directory, delegationEndpointDirectory: delegationEndpoint.directory, agentWorkspaceStorageRoot: context.globalStorageUri.fsPath };
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
  await delegationEndpointRegistry?.clear().catch(() => undefined);
  delegationEndpointRegistry = undefined;
  await activeWorkspaceOwnership?.release();
  activeWorkspaceOwnership = undefined;
}
