import type { ExtensionContext } from "vscode";
import { ProgressLocation, RelativePattern, Uri, commands, env, window, workspace } from "vscode";
import { randomUUID } from "node:crypto";

import { FileAgentMcpConfigs, FileManagerMcpConfig } from "./bridge/mcp-config.js";
import {
  DEFAULT_BRIDGE_PORT,
  startBridge,
  type BridgeRuntime,
} from "./bridge/server.js";
import { createTerminalRoutes } from "./bridge/terminal-routes.js";
import { CommandTerminalService, createCommandRoutes, type CommandTerminalId } from "./bridge/command-terminals.js";
import { FileCommandEndpointRegistry, commandEndpointDirectory } from "./bridge/command-endpoint.js";
import { TerminalController, type TerminalSnapshot } from "./claude/terminals.js";
import { isNamedBuiltinAgentType, type TerminalId } from "./domain/contracts.js";
import { createVsCodeTerminalHost } from "./vscode/terminals.js";
import { FileManagerStore, ManagerIdentity, ManagerLifecycle } from "./claude/manager.js";
import { sessionIsResumable } from "./claude/sessions.js";
import { TranscriptBackupStore } from "./claude/transcript-backup.js";
import { ClaudeCommandProbe, spawnCommandRunner } from "./claude/preflight.js";
import { GitHubBoundaryError, GitHubClient, ProcessGhExecutor } from "./github/client.js";
import { readScaffoldState, scaffoldCatalogRevision, scaffoldProject } from "./scaffold/project.js";
import { basename, join } from "node:path";
import { FleetRegistry } from "./domain/fleet.js";
import { WriteLease } from "./domain/lease.js";
import { registerNativeFleetUi, type NativeFleetUiRegistration } from "./vscode/native-ui.js";
import type { AutoRunPreview } from "./vscode/auto-run.js";
import {
  ABOARD_SETTINGS,
  EMPTY_PROJECT_SETTINGS,
  MANAGER_RESTART_SETTINGS,
  PROJECT_SETTINGS_PATH,
  createLayeredReader,
  managerLaunchChanged,
  parseProjectSettings,
  readAboardConfiguration,
  type ProjectSettings,
} from "./configuration.js";
import { FileActivityStore, FileFleetStore, FileLegacySessionLedger, PersistOnChange } from "./runtime/persistence.js";
import { ActivityRecorder } from "./runtime/activity-recorder.js";
import { isInteractiveLaunch, shouldRecordEndedSession } from "./domain/activity.js";
import { completedCount, isUnsupportedRecord } from "./domain/run-plan.js";
import { isLiveSession } from "./vscode/fleet.js";
import { ReopenCoordinator, describeReopenOutcome } from "./claude/reopen.js";
import { registerReopenCommand } from "./vscode/reopen.js";
import { combineHandlers } from "./bridge/router.js";
import { DelegationCoordinator, DelegationError, type DelegationConfigurationSource } from "./bridge/delegation.js";
import { ABOARD_MCP_TOOL_PATTERN, createMcpHandler } from "./bridge/mcp.js";
import { GeneralPurposeQueue } from "./bridge/general-purpose-queue.js";
import { WorkerHookService, createWorkerHookRoutes } from "./bridge/worker-hooks.js";
import {
  ManagerBriefings,
  ManagerPromptService,
  ManagerStopService,
  RoadmapReminderService,
  createManagerHookRoutes,
  type BriefingSources,
  type RoadmapBriefing,
} from "./bridge/manager-hooks.js";
import { GitWorkingTreeInspector, WorkerLifecycleReconciler, createWorkerLifecycleRoutes, reportsResult } from "./bridge/lifecycle.js";
import {
  SessionLifecycleService,
  SessionProcessMonitor,
  SessionStartupProofs,
  createSessionLifecycleRoutes,
  type SessionEndReason,
} from "./bridge/session-lifecycle.js";
import { lockMarkerDirectory, lockMarkerPresent, sessionWrapperLayout, takeSessionExitRecord, watchLockMarkers, type SessionExitRecord } from "./runtime/lock-markers.js";
import { WorkspaceAgentIdCounter } from "./runtime/agent-id-counter.js";
import { PromptResolver } from "./claude/prompts.js";
import { GitHubDelegationPromptResolver } from "./github/prompt-adapter.js";
import { FileSystemPromptSpillStore } from "./claude/spill.js";
import { agentDefinitionPath, parseAgentDefinition, parseBuiltinAgentProfile, sanitizeAgentDefinition } from "./scaffold/agent-definition.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId as TerminalIdBrand } from "./domain/contracts.js";
import { ReviewCoordinator, type PullRequestOwnership, type ReviewTerminals } from "./github/review.js";

/** Generous worker proof-of-life window: cold starts include `uv` resolving the hook shim and the claude CLI boot. */
const STARTUP_PROOF_TIMEOUT_MS = 60_000;
const SESSION_LIVENESS_POLL_MS = 5_000;
import { registerReviewCommand } from "./vscode/review.js";
import { CachingGitClient, ProcessGitClient, type GitClient } from "./git/client.js";
import { AboardBranchCleanup, ProcessAboardBranchRepository } from "./git/branch-cleanup.js";
import { registerBranchCleanupCommand } from "./vscode/branch-cleanup.js";
import { AutoRunEngine, type AutoRunState, type PullRequestOwner } from "./auto/engine.js";
import { closeSettledAutoRunTerminal } from "./auto/terminal-cleanup.js";
import { WorktreeRunWorkspaces } from "./auto/worktree.js";
import { AUTO_RUN_DISALLOWED_TOOLS } from "./auto/permissions.js";
import { FileAutoRunStore } from "./runtime/persistence.js";
import { RuntimeAdmission, RuntimeStartup } from "./runtime/admission.js";
import { RuntimeLayout } from "./runtime/layout.js";
import { planSessionResume, resolveLaunchConfiguration, type LaunchConfiguration } from "./claude/launch.js";
import { deriveWriteCapability } from "./domain/capability.js";

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
  try { return parseProjectSettings(await readFile(join(workspaceRoot, ".aboard", "settings.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_PROJECT_SETTINGS;
    return { values: new Map(), diagnostics: [{ setting: PROJECT_SETTINGS_PATH, severity: "error", message: `Unable to read ${PROJECT_SETTINGS_PATH}: ${error instanceof Error ? error.message : "unknown error"}. Project overrides are ignored.` }] };
  }
}

async function repositoryChecks(workspaceRoot: string): Promise<readonly string[]> {
  const preferred = ["check", "lint", "test", "build"];
  try {
    const parsed: unknown = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return [];
    const available = new Set(Object.keys(scripts as Record<string, unknown>));
    return preferred.filter((name) => available.has(name)).map((name) => `npm run ${name}`);
  } catch { return []; }
}

function roadmapBriefing(github: GitHubClient): (signal: AbortSignal) => Promise<RoadmapBriefing | undefined> {
  return async () => {
    const snapshot = await github.readRoadmap();
    if (snapshot === undefined) return undefined;
    return {
      number: snapshot.number,
      tasks: snapshot.tasks,
      carrierCount: snapshot.carrierCount,
      nearBound: snapshot.nearBound,
      duplicateSubjects: snapshot.duplicateSubjects,
    };
  };
}

function briefingSources(
  git: GitClient,
  github: GitHubClient,
  workspaceRoot: string,
  previousSessionAt: () => string | undefined,
  autoRunState: () => AutoRunState | undefined,
): BriefingSources {
  return {
    repository: async () => {
      const [defaultBranch, checks, codebase] = await Promise.all([
        git.defaultBranch(),
        repositoryChecks(workspaceRoot),
        // Its own probe: a survey that fails costs its line, not the section
        // that also carries the default branch and the baseline checks.
        git.codebase().catch(() => undefined),
      ]);
      return { name: basename(workspaceRoot), defaultBranch, checks, ...(codebase === undefined ? {} : { codebase }) };
    },
    git: async () => {
      const status = await git.status();
      return {
        branch: status.branch ?? "detached",
        head: await git.headSha(),
        dirty: status.entries.length > 0,
      };
    },
    github: async () => {
      const since = previousSessionAt();
      const [roadmap, pullRequests, merges] = await Promise.all([
        github.listRoadmapIssues(),
        github.listOpenPullRequests(),
        since === undefined ? Promise.resolve([]) : github.listUnreviewedMerges(since),
      ]);
      return {
        issues: roadmap.map((issue) => ({
          number: issue.number,
          title: issue.title,
          disposition: issue.disposition,
          blockedBy: issue.ready ? [] : issue.dependencyNumbers,
        })),
        openPullRequests: pullRequests,
        unreviewedMergeCount: merges.length,
      };
    },
    roadmap: roadmapBriefing(github),
    autoRun: () => {
      const state = autoRunState();
      if (state === undefined) return undefined;
      return {
        phase: state.phase,
        currentIssue: state.currentIssue,
        completedCount: state.completedCount,
        ...(state.waiting && state.currentPullRequest !== undefined
          ? { waitingOnPullRequest: state.currentPullRequest }
          : {}),
      };
    },
  };
}

function workerConfigurations(workspaceRoot: string): DelegationConfigurationSource {
  return { get: async (type) => {
    if (type === "general-purpose") return { shape: "default" };
    if (isNamedBuiltinAgentType(type)) {
      let source: string;
      try {
        source = await readFile(agentDefinitionPath(workspaceRoot, type), "utf8");
      } catch (error) {
        // Existing initialized projects may not have received the new profile
        // yet. Preserve the old launch until the user updates the scaffold.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { shape: "builtin", agentName: type };
        throw error;
      }
      const result = parseBuiltinAgentProfile(source);
      if (!result.ok) throw new Error(`Invalid ${type} builtin profile: ${result.reason}`);
      return resolveLaunchConfiguration({
        agentName: type,
        declaredModel: result.value.model,
        declaredEffort: result.value.effort,
        declaredCommand: result.value.command,
      });
    }
    const result = parseAgentDefinition(await readFile(agentDefinitionPath(workspaceRoot, type), "utf8"));
    if (!result.ok) throw new Error(`Invalid ${type} agent definition: ${result.reason}`);
    const sanitized = sanitizeAgentDefinition(result.value);
    return resolveLaunchConfiguration({
      agentName: type,
      systemPrompt: sanitized.prompt,
      declaredTools: sanitized.tools,
      declaredDescription: sanitized.description,
      extraFrontmatter: sanitized.extraFrontmatter,
      declaredModel: sanitized.model,
      declaredEffort: sanitized.effort,
      declaredCommand: sanitized.command,
    });
  } };
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
  const agentMcpConfigs = new FileAgentMcpConfigs(storageRoot, runtimeAdmission, () => initialized && bridge !== undefined);
  // Clean the pre-role-catalog Manager filename as well as current per-agent
  // registrations. New Manager launches use the same per-agent store as a
  // brainstormer, so the existing session-end cleanup covers both roles.
  const legacyManagerMcpConfig = new FileManagerMcpConfig(storageRoot, runtimeAdmission, () => initialized && bridge !== undefined);
  await Promise.all([agentMcpConfigs.clearAll().catch(() => undefined), legacyManagerMcpConfig.clear().catch(() => undefined)]);
  context.subscriptions.push({ dispose: () => { void agentMcpConfigs.clearAll(); void legacyManagerMcpConfig.clear(); } });
  const requireInitialized = (): boolean => {
    if (initialized) return true;
    void window.showInformationMessage(scaffoldState === "update-required"
      ? "aboard's project assets must be updated before this extension version can use them. Run Update .aboard/."
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
        // A foreground MCP delegation and the Manager's Stop hook share one
        // operator-controlled wall-clock bound.
        managerMcpTimeoutMs: currentConfiguration.managerStopTimeoutSeconds * 1000,
        managerRoadmapReminderBytes: currentConfiguration.managerRoadmapReminderBytes,
      };
    },
    terminalIdFactory: () => randomUUID() as TerminalId,
    startupProofs: sessionProofs,
    onStartupTimeout: (agentId, sessionId, timeoutMs) => {
      const label = fleet.get(agentId)?.terminal.name ?? `agent ${agentId}`;
      output.appendLine(`${label} (agent ${agentId}, session ${sessionId}) did not produce a SessionStart hook within ${Math.round(timeoutMs / 1000)}s; closing the terminal as a failed launch.`);
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
        output.appendLine(`Terminal ${event.terminalId} closed (${event.reason}, exit ${event.exitCode ?? "unknown"})`);
        // The terminal close is authoritative: stop tracking the process so a
        // later poll does not report it as dead when the shell dumped it.
        sessionMonitor.untrack(event.agentId);
        sessionProofs.cancel(event.agentId);
        void agentMcpConfigs.clear(event.agentId).catch(() => undefined);
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
    legacy: new FileLegacySessionLedger(runtime.root, runtimeAdmission),
    admission: () => initialized,
    now: () => new Date(),
    log: (message) => output.appendLine(message),
    onDidChange: () => { for (const listener of activityListeners) listener(); },
  });
  if (initialized) await activity.load().catch((error: unknown) => output.appendLine(`Activity store could not be read: ${error instanceof Error ? error.message : "unknown error"}`));
  const rememberEndedSession = async (
    session: AgentSession,
    endedAt: IsoTimestamp,
    outcome: "ended" | "killed" | "interrupted" = "ended",
    reason?: string,
  ): Promise<void> => {
    if (!initialized) return;
    // Capture this before the async transcript read: process-end settlement may
    // release the still-open terminal while the check is in flight.
    const terminalId = terminals.liveTerminalForAgent(session.identity.agentId);
    const conversationStarted = !isInteractiveLaunch(session)
      || await sessionIsResumable(session.sessionId, session.cwd ?? workspaceRoot);
    if (!shouldRecordEndedSession(session, conversationStarted)) {
      output.appendLine(`Discarded empty session for agent ${session.identity.agentId}; no Claude conversation started.`);
      return;
    }
    const classified = session.identity.type === "manager" || isInteractiveLaunch(session)
      ? outcome
      : outcome === "ended" ? "succeeded" : outcome;
    activity.recordAgent(session, classified, endedAt, {
      ...(reason === undefined ? {} : { reason }),
      ...(terminalId === undefined ? {} : { terminalId }),
    });
  };
  const managerStore = new FileManagerStore(runtime.root, runtimeAdmission);
  const github = new GitHubClient(new ProcessGhExecutor(workspaceRoot));
  let recordedManager = initialized ? await managerStore.load() : undefined;
  let agentIdCounter = WorkspaceAgentIdCounter.load(runtime.root, () => [
    ...fleet.list().map((session) => session.identity.agentId as string),
    ...(recordedManager === undefined ? [] : [recordedManager.agentId as string]),
  ], runtimeAdmission.isOpen);
  const lease = new WriteLease();
  const managerIdentity = new ManagerIdentity(recordedManager?.agentId, () => agentIdCounter.next());
  const transcripts = new TranscriptBackupStore({
    workspaceRoot,
    directory: runtime.transcripts(),
    retain: () => currentConfiguration.managerTranscriptBackups,
    log: (message) => output.appendLine(message),
  });
  if (initialized) await transcripts.prune();
  if (initialized && recordedManager !== undefined) void runtimeAdmission.run(() => transcripts.checkpoint(recordedManager!.sessionId));
  const launchConfigurations = workerConfigurations(workspaceRoot);
  const runtimeFiles = new FileSystemPromptSpillStore(workspaceRoot, runtime.root, {
    settings: join(context.extensionPath, "assets", "runtime", "aboard-hooks.json"),
    script: join(context.extensionPath, "assets", "runtime", "aboard_hook.py"),
  }, runtimeAdmission);
  await runtimeFiles.prune?.(new Set(fleet.list().map((session) => session.identity.agentId as string)));
  const wrapperLayout = sessionWrapperLayout(runtime.root, join(context.extensionPath, "assets", "runtime", "aboard_wrapper.py"));
  const claudeProbe = new ClaudeCommandProbe({ run: spawnCommandRunner(workspaceRoot) });
  // `sessionMonitor` is constructed below, after the settlement callbacks it
  // needs; the observer is only ever called from a launch, long after that.
  const coordinator = new DelegationCoordinator({ admission: () => initialized, workspaceRoot, fleet, lease, terminals, sessions: { observe: (agentId) => sessionMonitor.observe(agentId) }, onStaleLeaseRecovered: (holder, observation) => { output.appendLine(`Reclaimed the write lease from ${holder.agentId} (held since ${holder.acquiredAt}): terminal ${observation.terminal}, session ${observation.session}.`); void window.showWarningMessage(`aboard reclaimed the write lease from ${holder.agentId}: its terminal and session are both gone.`); }, configurations: launchConfigurations, prompts: new GitHubDelegationPromptResolver(new PromptResolver({ github })), spills: runtimeFiles, managerAgentId: () => managerIdentity.require(), mcpConfig: async (agentId, type) => type === "brainstormer" ? agentMcpConfigs.write({ port: bridge!.port, token: bridge!.token, agentId }) : undefined, shell: process.platform === "win32" ? "powershell" : "git-bash", disallowedTools: [ABOARD_MCP_TOOL_PATTERN], command: () => currentConfiguration.claudeCommand, effort: () => currentConfiguration.launchEffort, maxInlinePromptChars: currentConfiguration.maxInlinePromptChars, agentIdFactory: () => agentIdCounter.next(), sessionIdFactory: () => randomUUID() as SessionId, startupTimeoutMs: STARTUP_PROOF_TIMEOUT_MS, wrapper: wrapperLayout, preflight: (command) => claudeProbe.require(command) });
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
  const reportFailedLaunch = (agentId: AgentId, sessionId: SessionId, exit: SessionExitRecord | undefined): void => {
    const cause = exit?.error !== undefined
      ? `could not be started (${exit.error})`
      : `exited with code ${exit?.exitCode ?? "unknown"} before starting a session`;
    output.appendLine(`Launch failed for agent ${agentId} (session ${sessionId}): claude ${cause}. The terminal holds the error.`);
    // The launch is settled; the proof's timeout must not fire later and kill a
    // terminal whose error message is the whole point of keeping it.
    sessionProofs.cancel(agentId);
    void agentMcpConfigs.clear(agentId).catch(() => undefined);
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
    void window.showWarningMessage(`aboard could not start Claude: it ${cause}. Check the terminal for the error.`);
  };
  const sessionMonitor = new SessionProcessMonitor({
    probe: lockMarkerPresent,
    debug: (message) => output.appendLine(`[liveness] ${message}`),
    onProcessEnded: (observation) => {
      // The exit record is consumed either way, so a spent one can never be
      // read back against a later launch of the same agent.
      const exit = takeSessionExitRecord(observation.lockFile);
      void runtimeFiles.remove?.(observation.agentId).catch(() => undefined);
      void agentMcpConfigs.clear(observation.agentId).catch(() => undefined);
      if (observation.phase === "launching") {
        reportFailedLaunch(observation.agentId, observation.sessionId, exit);
        return;
      }
      const session = fleet.get(observation.agentId);
      if (session === undefined) return;
      const at = new Date().toISOString() as IsoTimestamp;
      if (!reportsResult(session)) {
        lease.releaseForTerminalOutcome(observation.agentId, at, "agent session process ended");
        void rememberEndedSession(session, at);
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
    void agentMcpConfigs.clear(agentId).catch(() => undefined);
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
      notify: (message) => enqueueManagerNotification(message),
      log: (message) => output.appendLine(message),
    }),
    github,
    launcher: coordinator,
    terminals: { close: (terminalId) => closeSettledAutoRunTerminal(terminals, fleet, terminalId) },
    store: new FileAutoRunStore(workspaceRoot, runtimeAdmission),
    notifier: {
      notify: (message) => enqueueManagerNotification(message),
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
        attempt: record.version === 2 ? record.attempt : 1,
        outcome: "discarded",
        ...(record.version === 2 ? { issueNumbers: record.plan.map((issue) => issue.number) } : {}),
      }),
    },
    settings: () => currentConfiguration.autoRun,
    discardBehavior: () => currentConfiguration.autoRun.discardBehavior,
    log: (message) => output.appendLine(message),
    onStateChange: (state) => void publishAutoRunState(state),
    onRecordChange: () => fleetUi?.refresh(),
  });
  activeAutoRun = autoRun;
  const ownership: PullRequestOwnership = { owner: (prNumber) => autoRun.owner(prNumber) };
  // `review_pr` focuses a live terminal or resumes a closed session. Resume is
  // safe because the agent has already run, so a transcript exists.
  const reviewTerminals: ReviewTerminals = {
    focus: (terminalId) => { try { terminals.show(terminalId); return true; } catch { return false; } },
    resume: async (owner: PullRequestOwner) => {
      const configuration = await launchConfigurations.get(owner.type);
      const plan = planSessionResume({
        agentId: owner.agentId,
        sessionId: owner.sessionId,
        agentType: owner.type,
        shell: process.platform === "win32" ? "powershell" : "git-bash",
        // `review_pr` exists to hand the session back to the user, so the
        // resumed terminal is driven by them even when it owned an afk worker.
        attended: true,
        command: currentConfiguration.claudeCommand,
        configuration,
        runtimeDirectory: runtime.root,
        disallowedTools: [ABOARD_MCP_TOOL_PATTERN, ...AUTO_RUN_DISALLOWED_TOOLS],
        ...(currentConfiguration.launchEffort === undefined ? {} : { effort: currentConfiguration.launchEffort }),
        // The session resumes at the tier it was launched under, so a doctor the
        // user reopens is the same agent they watched, not a cheaper one.
        ...(owner.difficulty === undefined ? {} : { difficulty: owner.difficulty }),
        wrapper: wrapperLayout,
      });
      // User-authored skills come from the checkout where this session ran;
      // generated launch files stay in VS Code workspace storage.
      await runtimeFiles.prepare(plan, owner.cwd);
      if (!runtimeAdmission.isOpen()) throw new Error("aboard runtime reset while preparing review resume");
      const at = new Date().toISOString() as IsoTimestamp;
      const terminal = terminals.create({
        agentId: owner.agentId,
        sessionId: owner.sessionId,
        agentType: owner.type,
        issueNumbers: [owner.issueNumber],
        name: `aboard: resume pull request ${owner.prNumber}`,
        ...(owner.cwd === undefined ? {} : { cwd: owner.cwd }),
        initialCommand: plan.commandLine,
        attended: true,
        startupTimeoutMs: STARTUP_PROOF_TIMEOUT_MS,
      });
      // The agent finished, so its fleet row is spent history; `restart` reuses
      // the identity rather than leaving a live terminal untracked.
      const recorded = fleet.get(owner.agentId);
      if (recorded !== undefined && (recorded.lifecycle.status === "completed" || recorded.lifecycle.status === "failed")) {
        fleet.restart(owner.agentId, { terminalId: terminal.terminalId, name: terminal.name }, at, undefined, true);
        fleet.transition(owner.agentId, { status: "running", startedAt: at }, at);
      }
      terminals.show(terminal.terminalId);
    },
  };
  const reviews = new ReviewCoordinator(github, coordinator, ownership, reviewTerminals);
  // Assigned once the Manager lifecycle exists below; the coordinator only calls
  // it when a manager is reopened, which cannot happen before activation ends.
  let resumeManager: (() => Promise<void>) | undefined;
  const reopen = new ReopenCoordinator({
    activity: { entries: () => activity.store() },
    fleet,
    terminals: {
      isOpen: (terminalId) => terminals.list().some((terminal) => terminal.terminalId === terminalId && terminal.status === "open"),
      liveTerminalFor: (agentId) => terminals.liveTerminalForAgent(agentId),
      show: (terminalId) => terminals.show(terminalId),
    },
    launcher: coordinator,
    isResumable: (sessionId, cwd) => sessionIsResumable(sessionId, cwd ?? workspaceRoot),
    reopenManager: async () => { await resumeManager?.(); },
  });
  const briefings = new ManagerBriefings(
    briefingSources(git, github, workspaceRoot, () => recordedManager?.updatedAt, () => autoRun.state()),
    fleet,
    lease,
    {
      write: async (slice: "state" | "roadmap", content: string) => {
        return runtimeAdmission.run(async () => {
          const path = join(runtime.events(), `brief-${slice}.txt`);
          await mkdir(runtime.events(), { recursive: true });
          await writeFile(path, content, "utf8");
          return path;
        });
      },
    },
  );
  // The Stop hook long-polls: it must keep waiting while background workers are
  // live, and wake the moment one of them files a result.
  const managerStop = new ManagerStopService({
    fleet,
    waitForChange: (signal, afterRevision) => new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        registration.dispose();
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const registration = fleet.onDidChange(finish);
      const onAbort = (): void => finish();
      signal.addEventListener("abort", onAbort, { once: true });
      // A report may have landed between the service checking the fleet and
      // this listener being installed. The revision closes that lost wakeup.
      if (signal.aborted || fleet.revision() !== afterRevision) finish();
    }),
  });
  const roadmapReminders = new RoadmapReminderService({ roadmap: roadmapBriefing(github) });
  const generalPurposeQueue = new GeneralPurposeQueue({
    git,
    launcher: coordinator,
    canLaunch: () => initialized && autoRun.state() === undefined,
    isAgentLive: (agentId) => {
      const session = fleet.get(agentId);
      return session !== undefined && isLiveSession(session);
    },
    onLaunch: (agentId, remaining) => {
      const message = `Queued general-purpose task launched as agent ${agentId}${remaining === 0 ? "." : `; ${remaining} task(s) remain queued.`}`;
      output.appendLine(message);
      const managerAgentId = managerIdentity.current();
      if (managerAgentId !== undefined && fleet.get(managerAgentId)?.identity.type === "manager") {
        fleet.enqueueNotification(managerAgentId, message, new Date().toISOString() as IsoTimestamp);
      }
    },
    onError: (message) => output.appendLine(`General-purpose queue is waiting: ${message}.`),
  });
  context.subscriptions.push({ dispose: () => generalPurposeQueue.dispose() });
  const managerPrompts = new ManagerPromptService(fleet, coordinator, undefined, {
    startAutoRun: (options) => options?.dry === true
      ? autoRun.dryRun({
          ...(options.additionalGuideline === undefined ? {} : { additionalGuideline: options.additionalGuideline }),
        })
      : autoRun.start({
          ...(options?.additionalGuideline === undefined ? {} : { additionalGuideline: options.additionalGuideline }),
        }),
    reviewPullRequest: (focus) => reviews.review(focus === undefined ? {} : { focus }),
    reopenSession: (selector) => reopen.reopenLatest(selector),
  }, terminals, roadmapReminders, generalPurposeQueue);
  const commandEndpoint = new FileCommandEndpointRegistry({ directory: commandEndpointDirectory(process.platform, process.env, homedir()) });
  await commandEndpoint.clearWorkspace(workspaceRoot).catch(() => undefined);
  commandEndpointRegistry = commandEndpoint;
  context.subscriptions.push({ dispose: () => void commandEndpoint.clear() });
  const bridgeStartup = new RuntimeStartup(runtimeAdmission);
  const startRuntimeBridge = (): Promise<void> => {
    if (!initialized || bridge !== undefined) return Promise.resolve();
    return bridgeStartup.run(async () => {
    if (!initialized || bridge !== undefined) return;
    bridge = await startBridge({
    preferredPort: currentConfiguration.bridgePort,
    handler: combineHandlers(createMcpHandler(coordinator, { fleet, services: { github, reviews, autoRun, continuations: { continue: async (callerAgentId, targetAgentId, prompt) => {
      const option = await reopen.findContinuation(targetAgentId);
      if (option === undefined) throw new DelegationError("unknown-agent", `Unknown agent ${targetAgentId}`);
      if (!option.resumable) throw new DelegationError("unresumable-session", `Agent ${targetAgentId} no longer has a resumable conversation`);
      const candidate = option.candidate;
      return coordinator.continue({
        agentId: candidate.agentId,
        type: candidate.type,
        sessionId: candidate.sessionId,
        terminalName: `aboard: ${candidate.description}`,
        ...(candidate.issueNumbers === undefined ? {} : { issueNumbers: candidate.issueNumbers }),
        ...(candidate.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
        ...(candidate.cwd === undefined ? {} : { cwd: candidate.cwd }),
        ...(candidate.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
      }, prompt, callerAgentId);
    } }, log: (message) => output.appendLine(message) } }), createManagerHookRoutes(briefings, managerStop, managerPrompts, roadmapReminders, (agentId) => {
      const session = fleet.get(agentId);
      if (session?.identity.type === "manager") void runtimeAdmission.run(() => transcripts.checkpoint(session.sessionId));
    }), createWorkerLifecycleRoutes(lifecycle), createWorkerHookRoutes(new WorkerHookService(fleet)), createSessionLifecycleRoutes({ service: sessionLifecycle, proofs: sessionProofs }), createTerminalRoutes(terminals), createCommandRoutes(commandTerminals)),
    logger: { info: (message) => output.appendLine(message), error: (message) => output.appendLine(`Error: ${message}`) },
    });
    bridgeEnvironment = { port: bridge.port, token: bridge.token };
    try {
    const published = await commandEndpoint.publish({
      version: 1,
      host: bridge.host,
      port: bridge.port,
      workspaceRoot,
      commandToken: bridge.commandToken,
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
    try {
      const result = await autoRun.startPreviewed(preview);
      if (!result.started) void window.showWarningMessage("preview" in result
        ? "The auto-run plan changed. Review the updated preview, then start again."
        : `aboard cannot start an auto-run: ${result.reason}.`);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unable to start the auto-run";
      void window.showErrorMessage(reason);
      return { started: false as const, reason };
    }
  };
  fleetUi = registerNativeFleetUi(context, {
    port: () => bridge?.port,
    fleet,
    lease,
    terminals,
    isInitialized: () => initialized,
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
  const enqueueManagerNotification = (message: string): void => {
    output.appendLine(message);
    const managerAgentId = managerIdentity.current();
    if (managerAgentId === undefined) return;
    if (fleet.get(managerAgentId)?.identity.type !== "manager") return;
    try { fleet.enqueueNotification(managerAgentId, message, new Date().toISOString() as IsoTimestamp); }
    catch (error) { output.appendLine(`Unable to queue auto-run notification: ${error instanceof Error ? error.message : "unknown error"}`); }
  };
  const alertAboutAutoRun = (message: string, pullRequestUrl?: string): void => {
    enqueueManagerNotification(message);
    const actions = pullRequestUrl === undefined ? ["Show Log"] : ["Open Pull Request", "Show Log"];
    void window.showWarningMessage(message, ...actions).then((choice) => {
      if (choice === "Open Pull Request" && pullRequestUrl !== undefined) void env.openExternal(Uri.parse(pullRequestUrl));
      else if (choice === "Show Log") output.show(true);
    });
  };
  const publishAutoRunState = async (state: ReturnType<AutoRunEngine["state"]> | undefined): Promise<void> => {
    fleetUi?.refresh();
    await commands.executeCommand("setContext", "aboard.autoRunActive", state !== undefined);
    await commands.executeCommand("setContext", "aboard.autoRunWaiting", state?.waiting === true);
  };
  await publishAutoRunState(undefined);
  // Persisting into an uninitialized project would recreate `.aboard/` behind the
  // user's back — including right after they deleted it.
  persistence = new PersistOnChange((listener) => fleet.onDidChange(listener), async () => { if (initialized) await fleetStore.save(fleet.toPersistenceDto()); }, (error) => output.appendLine(`Fleet persistence failed: ${error instanceof Error ? error.message : "unknown error"}`));
  // Disposed through subscriptions like every other resource; `deactivate` also
  // awaits it so queued writes are flushed on a normal shutdown.
  context.subscriptions.push({ dispose: () => void persistence?.dispose() });
  const manager = new ManagerLifecycle({
    store: managerStore, terminals, workspaceRoot, runtimeDirectory: runtime.root, files: runtimeFiles, admission: runtimeAdmission.isOpen,
    shell: process.platform === "win32" ? "powershell" : "git-bash",
    disallowedTools: currentConfiguration.managerDisallowedTools,
    preflight: (command) => claudeProbe.require(command),
    command: () => currentConfiguration.claudeCommand,
    effort: () => currentConfiguration.launchEffort,
    agentIdFactory: () => managerIdentity.require(),
    isResumable: sessionIsResumable,
    restoreTranscript: (sessionId) => runtimeAdmission.run(() => transcripts.restore(sessionId)),
    wrapper: wrapperLayout,
    // The aboard MCP server is registered per Manager launch and nowhere in the
    // project, so no catalog-less worker and no hand-started `claude` connects it.
    mcpConfig: () => agentMcpConfigs.write({ port: bridge!.port, token: bridge!.token, agentId: managerIdentity.require() }),
  });
  // A launched Manager reuses its recorded identity: an unknown one registers,
  // a live one reattaches to its new terminal, an ended one restarts.
  const absorbLaunchedManager = (terminal: TerminalSnapshot): void => {
    const startedAt = new Date().toISOString() as IsoTimestamp;
    if (fleet.get(terminal.agentId) === undefined) {
      fleet.register({ identity: { agentId: terminal.agentId, type: "manager" }, sessionId: terminal.sessionId, terminal: { terminalId: terminal.terminalId, name: terminal.name }, lifecycle: { status: "starting", startedAt }, resultDelivery: { mode: "none" }, attended: true, telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 } } satisfies AgentSession, startedAt);
    } else {
      const prior = fleet.get(terminal.agentId)!;
      if (["starting", "running", "awaiting-user"].includes(prior.lifecycle.status)) {
        fleet.reattach(terminal.agentId, { terminalId: terminal.terminalId, name: terminal.name }, startedAt, terminal.sessionId);
      } else {
        fleet.restart(terminal.agentId, { terminalId: terminal.terminalId, name: terminal.name }, startedAt, terminal.sessionId);
      }
    }
    fleet.transition(terminal.agentId, { status: "running", startedAt }, startedAt);
  };
  // The UI offers resume and new as separate actions, so the launch path never
  // has to interrupt with a "which did you mean?" prompt.
  const launch = async (mode: "resume" | "new") => {
    if (!requireInitialized()) return;
    try {
      absorbLaunchedManager(await manager.start(mode));
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to launch Manager"); }
    finally { await publishManagerState(); }
  };
  // Reopening the Manager from a session-reopen surface is a resume under the hood.
  resumeManager = async () => { await launch("resume"); };
  const reconcileStaleSessions = (): void => {
    const openTerminalIds = new Set(terminals.list().filter((terminal) => terminal.status === "open").map((terminal) => terminal.terminalId));
    const stale = fleet.list().filter((session) => isLiveSession(session) && !openTerminalIds.has(session.terminal.terminalId));
    for (const session of stale) {
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

  const publishManagerState = async () => {
    await commands.executeCommand("setContext", "aboard.managerLive", fleet.list().some((entry) => entry.identity.type === "manager"));
  };
  const publishScaffoldState = async () => {
    const wasInitialized = initialized;
    scaffoldState = await readScaffoldState(workspaceRoot, expectedScaffoldRevision).catch(() => "uninitialized" as const);
    const next = scaffoldState === "ready";
    if (initialized && !next) {
      initialized = false;
      const runtimeDrained = runtimeAdmission.close();
      generalPurposeQueue.clear();
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
      managerIdentity.reset();
      recordedManager = undefined;
      bridgeEnvironment = undefined;
      await bridge?.stop();
      bridge = undefined;
      await Promise.all([
        legacyManagerMcpConfig.clear().catch(() => undefined),
        agentMcpConfigs.clearAll().catch(() => undefined),
        commandEndpoint.clear().catch(() => undefined),
      ]);
      await rm(runtime.root, { recursive: true, force: true });
      output.appendLine(scaffoldState === "uninitialized"
        ? "Project state directory .aboard/ was removed; the aboard session was discarded."
        : "aboard's project assets no longer match this extension; runtime access was closed until they are updated.");
    }
    initialized = next;
    if (initialized && !wasInitialized) {
      runtimeAdmission.open();
      recordedManager = await managerStore.load();
      managerIdentity.restore(recordedManager?.agentId);
      agentIdCounter = WorkspaceAgentIdCounter.load(runtime.root, () => [
        ...fleet.list().map((session) => session.identity.agentId as string),
        ...(recordedManager === undefined ? [] : [recordedManager.agentId as string]),
      ], runtimeAdmission.isOpen);
      // The store on disk is the only history a newly initialized project has.
      await activity.load().catch((error: unknown) => output.appendLine(`Activity store could not be read: ${error instanceof Error ? error.message : "unknown error"}`));
      if (recordedManager !== undefined) void runtimeAdmission.run(() => transcripts.checkpoint(recordedManager!.sessionId));
    }
    if (initialized) await startRuntimeBridge();
    await commands.executeCommand("setContext", "aboard.initialized", next);
    await commands.executeCommand("setContext", "aboard.scaffoldUpdateRequired", scaffoldState === "update-required");
    if (scaffoldState !== "update-required") scaffoldUpdateWarningShown = false;
    if (scaffoldState === "update-required" && !scaffoldUpdateWarningShown) {
      scaffoldUpdateWarningShown = true;
      void window.showWarningMessage("aboard's project assets were created by another extension version. Update .aboard/ before starting or resuming aboard.");
    }
    fleetUi.refresh();
    await publishManagerState();
  };
  await publishScaffoldState();
  const scaffoldWatcher = workspace.createFileSystemWatcher(new RelativePattern(workspaceRoot, ".aboard/**"));
  for (const event of [scaffoldWatcher.onDidCreate, scaffoldWatcher.onDidChange, scaffoldWatcher.onDidDelete]) {
    context.subscriptions.push(event(() => void publishScaffoldState()));
  }
  context.subscriptions.push(
    scaffoldWatcher,
    window.onDidChangeWindowState((state) => { if (state.focused) void publishScaffoldState(); }),
    fleet.onDidChange(() => void publishManagerState()),
  );
  const scaffold = async () => {
    try {
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
    finally { await publishScaffoldState(); }
  };
  context.subscriptions.push(
    commands.registerCommand("aboard.initializeProject", scaffold),
    commands.registerCommand("aboard.updateProject", async () => {
      if (scaffoldState === "uninitialized") { requireInitialized(); return; }
      const confirmed = await window.showWarningMessage(
        "Update aboard's project assets?",
        {
          modal: true,
          detail: "aboard updates the current agents, hooks, and skills it owns under .aboard/. Files you have not touched are replaced with this version's copies, and unchanged files this version retired are removed. Assets you edited yourself are kept and listed afterwards rather than overwritten. Running sessions keep their already-prepared launch bundles.",
        },
        "Update",
      );
      if (confirmed === "Update") await scaffold();
    }),
    commands.registerCommand("aboard.newManager", () => launch("new")),
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
    registerReviewCommand({ registerCommand: (command, callback) => commands.registerCommand(command, (...args) => requireInitialized() ? callback(...args) : undefined), info: (message) => { void window.showInformationMessage(message); }, warning: (message) => { void window.showWarningMessage(message); }, error: (message) => { void window.showErrorMessage(message); } }, reviews),
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
    commands.registerCommand("aboard.continueAutoRun", () => { if (requireInitialized()) autoRun.continueNow(); }),
    // A wait outstanding when the window regains focus is polled immediately,
    // so returning to VS Code after merging does not cost a poll interval.
    window.onDidChangeWindowState((state) => {
      const record = autoRun.persisted();
      if (state.focused && autoRun.state()?.waiting === true && record?.version === 2 && record.settings.branchMode !== "single-branch") autoRun.continueNow();
    }),
  );
  // Recovery has no notification: the Auto Run view is the place, and it
  // revalidates on activation, on visibility, on focus, and on a timer.
  void autoRun.refresh();
  const reloadConfiguration = (restartHint: (before: typeof currentConfiguration, after: typeof currentConfiguration) => boolean) => {
    const next = configuration(projectSettings.values);
    const previous = currentConfiguration;
    currentConfiguration = next.value;
    if (previous.managerTranscriptBackups !== next.value.managerTranscriptBackups) void transcripts.prune();
    fleetUi?.checkAutoRun();
    for (const diagnostic of [...projectSettings.diagnostics, ...next.diagnostics]) output.appendLine(`Configuration: ${diagnostic.message}`);
    if (restartHint(previous, next.value)) void window.showInformationMessage("Manager launch settings changed. Restart the Manager to apply them.");
  };
  context.subscriptions.push(workspace.onDidChangeConfiguration((event) => {
    if (!ABOARD_SETTINGS.some((setting) => event.affectsConfiguration(setting))) return;
    reloadConfiguration(() => [...MANAGER_RESTART_SETTINGS].some((setting) => event.affectsConfiguration(setting)));
  }));
  const settingsWatcher = workspace.createFileSystemWatcher(new RelativePattern(workspaceRoot, PROJECT_SETTINGS_PATH));
  const reloadProjectSettings = async () => {
    projectSettings = await readProjectSettings(workspaceRoot);
    reloadConfiguration(managerLaunchChanged);
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
