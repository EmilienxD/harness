import type { ExtensionContext } from "vscode";
import { RelativePattern, commands, window, workspace } from "vscode";
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
import { isBuiltinAgentType, type TerminalId } from "./domain/contracts.js";
import { createVsCodeTerminalHost } from "./vscode/terminals.js";
import { FileManagerStore, ManagerLifecycle } from "./claude/manager.js";
import { sessionTranscriptExists } from "./claude/sessions.js";
import type { WorkerPermissionMode } from "./claude/launch.js";
import { GitHubBoundaryError, GitHubClient, ProcessGhExecutor } from "./github/client.js";
import { readScaffoldState, scaffoldProject } from "./scaffold/project.js";
import { createVendoredSkillInstaller } from "./scaffold/vendored.js";
import { join } from "node:path";
import { FleetRegistry } from "./domain/fleet.js";
import { WriteLease } from "./domain/lease.js";
import { registerNativeFleetUi } from "./vscode/native-ui.js";
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
import { GitWorkingTreeInspector, WorkerLifecycleReconciler, createWorkerLifecycleRoutes, reportsResult } from "./bridge/lifecycle.js";
import { PromptResolver } from "./claude/prompts.js";
import { GitHubDelegationPromptResolver } from "./github/prompt-adapter.js";
import { FileSystemPromptSpillStore } from "./claude/spill.js";
import { parseAgentDefinition } from "./scaffold/agent-definition.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId as TerminalIdBrand } from "./domain/contracts.js";
import { ReviewCoordinator, type PullRequestOwnership, type ReviewTerminals } from "./github/review.js";
import { registerReviewCommand } from "./vscode/review.js";
import { ProcessGitClient, type GitClient } from "./git/client.js";
import { AutoRunEngine, type PullRequestOwner } from "./auto/engine.js";
import { FileAutoRunStore } from "./runtime/persistence.js";
import { planSessionResume } from "./claude/launch.js";
import { deriveWriteCapability } from "./domain/capability.js";

let bridge: BridgeRuntime | undefined;
let persistence: PersistOnChange | undefined;
let activeAutoRun: AutoRunEngine | undefined;

/**
 * Reads the effective configuration. `inspect` rather than `get` is deliberate:
 * `get` collapses every scope into one value, which would leave the project file
 * unable to override a global while a contributed default is present.
 */
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

/**
 * Briefing sources for the Manager's split SessionStart hooks. Each slice is
 * independently fallible by design: `ManagerBriefings` converts a rejection into
 * a one-line "unavailable" note, so one broken `gh` call degrades a single slice
 * instead of losing the whole briefing.
 */
function briefingSources(git: GitClient, github: GitHubClient, previousSessionAt: () => string | undefined): BriefingSources {
  return {
    git: async () => {
      const status = await git.status();
      return {
        branch: status.branch ?? "detached",
        head: await git.headSha(),
        dirty: status.entries.length > 0,
      };
    },
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
    // The builtin types resolve to Claude Code's own definitions: aboard
    // scaffolds no file for them and there is no frontmatter to read for the
    // tool set — capability for both is fixed in `launchWriteCapability`, and
    // deriving from an unreadable file would conservatively mark even Explore
    // write-capable.
    if (isBuiltinAgentType(type)) return { shape: "agent-defined", agentName: type };
    const result = parseAgentDefinition(await readFile(join(workspaceRoot, ".claude", "agents", `${type}.md`), "utf8"));
    if (!result.ok) throw new Error(`Invalid ${type} agent definition: ${result.reason}`);
    return { shape: "agent-defined", agentName: type, declaredTools: result.value.tools };
  } };
}

/** Exposed so the VS Code integration suite can locate the out-of-workspace discovery file. */
export interface AboardExtensionApi {
  readonly bridgeDiscoveryPath: string;
}

export async function activate(context: ExtensionContext): Promise<AboardExtensionApi | undefined> {
  if ((workspace.workspaceFolders?.length ?? 0) > 1) { void window.showErrorMessage("aboard v1 supports exactly one workspace folder. Open the project in a single-root window."); return undefined; }
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot === undefined) return undefined;
  const storageRoot = (context.storageUri ?? context.globalStorageUri).fsPath;
  await mkdir(storageRoot, { recursive: true });

  const output = window.createOutputChannel("aboard");
  context.subscriptions.push(output);
  let projectSettings = await readProjectSettings(workspaceRoot);
  const initialConfiguration = configuration(projectSettings.values);
  const initialDiagnostics = [...projectSettings.diagnostics, ...initialConfiguration.diagnostics];
  for (const diagnostic of initialDiagnostics) output.appendLine(`Configuration: ${diagnostic.message}`);
  if (initialDiagnostics.length > 0) void window.showWarningMessage(initialDiagnostics.map((item) => item.message).join(" "));
  let currentConfiguration = initialConfiguration.value;
  let bridgeEnvironment: { port: number; token: string } | undefined;
  let lifecycle: WorkerLifecycleReconciler | undefined;
  let initialized = false;
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
      if (event.type !== "terminal-closed") return;
      const closed = fleet?.get(event.agentId);
      if (closed === undefined) return;
      if (!reportsResult(closed)) {
        const occurredAt = event.occurredAt as IsoTimestamp;
        // The reconciler would have released the lease; do it here for the paths
        // that skip it, or an interactive agent's lease outlives its terminal.
        lease.releaseForTerminalOutcome(event.agentId, occurredAt, "agent terminal closed");
        fleet.remove(event.agentId, occurredAt);
      } else void lifecycle?.terminalClosed(event).catch((error: unknown) => output.appendLine(`Lifecycle reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`));
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
  const coordinator = new DelegationCoordinator({ fleet, lease, terminals, configurations: workerConfigurations(workspaceRoot), prompts: new GitHubDelegationPromptResolver(new PromptResolver({ github })), spills: new FileSystemPromptSpillStore(workspaceRoot), managerAgentId, shell: process.platform === "win32" ? "powershell" : "git-bash", permissionMode: currentConfiguration.workerPermissionMode, command: () => currentConfiguration.claudeCommand, maxInlinePromptChars: currentConfiguration.maxInlinePromptChars, agentIdFactory: () => randomUUID() as AgentId, sessionIdFactory: () => randomUUID() as SessionId });
  lifecycle = new WorkerLifecycleReconciler({ fleet, lease, completions: coordinator, workingTree: new GitWorkingTreeInspector() });
  const git: GitClient = new ProcessGitClient(workspaceRoot);
  const autoRun = new AutoRunEngine({
    git,
    github,
    launcher: coordinator,
    terminals: { close: (terminalId) => terminals.kill(terminalId) },
    store: new FileAutoRunStore(workspaceRoot),
    notifier: { notify: (message) => enqueueManagerNotification(message) },
    settings: () => currentConfiguration.autoRun,
    log: (message) => output.appendLine(message),
    onStateChange: (state) => void publishAutoRunState(state),
  });
  activeAutoRun = autoRun;
  const ownership: PullRequestOwnership = { owner: (prNumber) => autoRun.owner(prNumber) };
  // `review_pr` focuses a live terminal or resumes a closed session. Resume is
  // safe because the agent has already run, so a transcript exists.
  const reviewTerminals: ReviewTerminals = {
    focus: (terminalId) => { try { terminals.show(terminalId); return true; } catch { return false; } },
    resume: async (owner: PullRequestOwner) => {
      // An unread tool set resolves to the restrictive answer, so a resumed
      // worker is treated as write-capable and takes the lease like any other.
      const capability = deriveWriteCapability(undefined);
      const plan = planSessionResume({
        agentId: owner.agentId,
        sessionId: owner.sessionId,
        agentType: owner.type,
        shell: process.platform === "win32" ? "powershell" : "git-bash",
        permissionMode: currentConfiguration.workerPermissionMode,
        command: currentConfiguration.claudeCommand,
        writeCapability: capability,
      });
      const at = new Date().toISOString() as IsoTimestamp;
      const acquisition = lease.acquire(capability, { agentId: owner.agentId, sessionId: owner.sessionId }, at, "resume pull request session");
      if (!acquisition.acquired) throw new Error(`Write lease is held by ${acquisition.holder.agentId}; release it before resuming this session.`);
      const terminal = terminals.create({
        agentId: owner.agentId,
        sessionId: owner.sessionId,
        agentType: owner.type,
        issueNumber: owner.issueNumber,
        name: `aboard: resume pull request ${owner.prNumber}`,
        initialCommand: plan.commandLine,
      });
      // The agent finished, so its fleet row is spent history; `restart` reuses
      // the identity rather than leaving a live terminal untracked.
      const recorded = fleet.get(owner.agentId);
      if (recorded !== undefined && (recorded.lifecycle.status === "completed" || recorded.lifecycle.status === "failed")) {
        fleet.restart(owner.agentId, { terminalId: terminal.terminalId, name: terminal.name }, at);
        fleet.transition(owner.agentId, { status: "running", startedAt: at }, at);
      }
      terminals.show(terminal.terminalId);
    },
  };
  const reviews = new ReviewCoordinator(github, coordinator, ownership, reviewTerminals);
  const briefings = new ManagerBriefings(
    briefingSources(git, github, () => recordedManager?.updatedAt),
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
  const managerPrompts = new ManagerPromptService(fleet, coordinator, undefined, {
    startAutoRun: () => autoRun.start(),
    reviewPullRequest: () => reviews.review(),
  });
  const discovery = new FileBridgeDiscoveryPersistence(storageRoot);
  bridge = await startBridge({
    preferredPort: currentConfiguration.bridgePort,
    handler: combineHandlers(createMcpHandler(coordinator, { github, reviews, autoRun }), createManagerHookRoutes(briefings, managerStop, managerPrompts), createWorkerLifecycleRoutes(lifecycle), createWorkerHookRoutes(new WorkerHookService(fleet)), createTerminalRoutes(terminals)),
    persistence: discovery,
    logger: { info: (message) => output.appendLine(message), error: (message) => output.appendLine(`Error: ${message}`) },
  });
  bridgeEnvironment = { port: bridge.port, token: bridge.token };
  registerNativeFleetUi(context, bridge.port, fleet, lease, terminals);
  // Progress is pull, not push: one bounded line per transition, drained by the
  // Manager's UserPromptSubmit hook on the user's next message. If the user is
  // away for a whole afk spec, they learn the outcome when they return — which
  // is what "afk" means. With no Manager alive there is nobody to tell, so the
  // line goes to the output channel instead of being lost silently.
  const enqueueManagerNotification = (message: string): void => {
    output.appendLine(message);
    if (fleet.get(managerAgentId)?.identity.type !== "manager") return;
    try { fleet.enqueueNotification(managerAgentId, message, new Date().toISOString() as IsoTimestamp); }
    catch (error) { output.appendLine(`Unable to queue auto-run notification: ${error instanceof Error ? error.message : "unknown error"}`); }
  };
  const autoRunStatus = window.createStatusBarItem(undefined, 99);
  autoRunStatus.command = "aboard.stopAutoRun";
  context.subscriptions.push(autoRunStatus);
  const publishAutoRunState = async (state: ReturnType<AutoRunEngine["state"]> | undefined): Promise<void> => {
    if (state === undefined) {
      autoRunStatus.hide();
    } else {
      autoRunStatus.text = `$(sync~spin) Auto-run: spec #${state.specNumber} (${state.completedCount + 1}/${state.totalCount})`;
      autoRunStatus.tooltip = state.waiting
        ? `Waiting for you to merge the pull request for issue #${state.currentIssue ?? "?"}. Click to stop the run.`
        : `${state.phase} — issue #${state.currentIssue ?? "?"}. Click to stop the run.`;
      autoRunStatus.show();
    }
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
    store: managerStore, terminals, workspaceRoot,
    shell: process.platform === "win32" ? "powershell" : "git-bash",
    preset: currentConfiguration.managerToolPreset,
    disallowedTools: currentConfiguration.managerDisallowedTools,
    command: () => currentConfiguration.claudeCommand,
    permissionMode: () => currentConfiguration.workerPermissionMode,
    agentIdFactory: () => managerAgentId,
    transcriptExists: sessionTranscriptExists,
  });
  const warnKey = "aboard.manager.permissionWarning";
  // The UI offers resume and new as separate actions, so the launch path never
  // has to interrupt with a "which did you mean?" prompt.
  const launch = async (mode: "resume" | "new") => {
    const workerMode = currentConfiguration.workerPermissionMode;
    if (workerMode !== "bypass" && !context.globalState.get(warnKey)) { await window.showWarningMessage("Unattended workers may stall on permission prompts. For afk work, use the bypass permission mode."); await context.globalState.update(warnKey, true); }
    try {
      const terminal = await manager.start(mode);
      // Registration is only ever valid in `starting`; a relaunch of the same
      // Manager identity goes through `restart`, carrying the new session id so
      // hook routing by session keeps resolving.
      const startedAt = new Date().toISOString() as IsoTimestamp;
      if (fleet.get(terminal.agentId) === undefined) {
        fleet.register({ identity: { agentId: terminal.agentId, type: "manager" }, sessionId: terminal.sessionId, terminal: { terminalId: terminal.terminalId, name: terminal.name }, lifecycle: { status: "starting", startedAt }, resultDelivery: { mode: "none" }, telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 } } satisfies AgentSession, startedAt);
      } else {
        fleet.restart(terminal.agentId, { terminalId: terminal.terminalId, name: terminal.name }, startedAt, terminal.sessionId);
      }
      fleet.transition(terminal.agentId, { status: "running", startedAt }, startedAt);
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to launch Manager"); }
    finally { await publishManagerState(); }
  };
  // `aboard.initialized` drives the welcome view and the Initialize/Update pair.
  // `aboard.managerLive` hides the launch actions while a Manager is running, and
  // `aboard.managerResumable` shows Resume only when a session exists to resume.
  const publishManagerState = async () => {
    const recorded = await managerStore.load().catch(() => undefined);
    await commands.executeCommand("setContext", "aboard.managerLive", fleet.list().some((entry) => entry.identity.type === "manager"));
    await commands.executeCommand("setContext", "aboard.managerResumable", recorded !== undefined);
  };
  const publishScaffoldState = async () => {
    const state = await readScaffoldState(workspaceRoot).catch(() => "uninitialized" as const);
    const next = state === "initialized";
    // `.aboard/` is the project's state root. When it disappears the aboard
    // session it described is gone: live terminals are closed and the fleet is
    // discarded, rather than leaving the tree showing agents whose backing state
    // no longer exists.
    if (initialized && !next) {
      for (const terminal of terminals.list()) {
        if (terminal.status === "open") try { terminals.kill(terminal.terminalId); } catch { /* already closing */ }
      }
      const at = new Date().toISOString() as IsoTimestamp;
      if (lease.current() !== undefined) lease.forceRelease(at, "project state was removed");
      fleet.clear(at);
      output.appendLine("Project state directory .aboard/ was removed; the aboard session was discarded.");
    }
    initialized = next;
    await commands.executeCommand("setContext", "aboard.initialized", next);
    await publishManagerState();
  };
  await publishScaffoldState();
  // Watch the whole directory, not just the manifest: deleting `.aboard/` in the
  // explorer does not reliably raise a per-file delete for its contents. The
  // window-focus re-check covers a deletion made entirely outside VS Code.
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
      const first = await readScaffoldState(workspaceRoot) === "uninitialized";
      const report = await scaffoldProject({
        projectRoot: workspaceRoot,
        assetRoot: join(context.extensionPath, "assets", "scaffold"),
        installer: createVendoredSkillInstaller(),
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
      void window.showInformationMessage(`aboard ${first ? "initialized" : "updated"} (${report.created.length} created, ${report.updated.length} updated, ${report.removed.length} removed, ${report.preserved.length} preserved, ${report.installed.length} skills installed).`);
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to scaffold aboard project assets"); }
    finally { await publishScaffoldState(); }
  };
  context.subscriptions.push(
    commands.registerCommand("aboard.initializeProject", scaffold),
    commands.registerCommand("aboard.updateProject", async () => {
      const confirmed = await window.showWarningMessage(
        "Reset aboard's project assets?",
        {
          modal: true,
          detail: "aboard reinstalls the agents, hooks, and skills it owns under .aboard/ and .claude/: files you have not touched are replaced with this version's copies, and files aboard no longer ships are deleted. Assets you edited yourself are kept and listed afterwards rather than overwritten, and your own project files are never touched. Running agents keep going.",
        },
        "Reset",
      );
      if (confirmed === "Reset") await scaffold();
    }),
    commands.registerCommand("aboard.resumeManager", () => launch("resume")),
    commands.registerCommand("aboard.newManager", () => launch("new")),
    registerReviewCommand({ registerCommand: (command, callback) => commands.registerCommand(command, callback), info: (message) => { void window.showInformationMessage(message); }, error: (message) => { void window.showErrorMessage(message); } }, reviews),
    commands.registerCommand("aboard.startAutoRun", async () => {
      try {
        const result = await autoRun.start();
        if (!result.started) void window.showWarningMessage(`aboard cannot start an auto-run: ${result.reason}.`);
        else void window.showInformationMessage(`Auto-run started on spec #${result.spec.number} — ${result.issues.length} issue(s), review ${result.reviewMode ? "on" : "off"}.`);
      } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to start the auto-run"); }
    }),
    commands.registerCommand("aboard.stopAutoRun", () => autoRun.stop()),
    commands.registerCommand("aboard.continueAutoRun", () => autoRun.continueNow()),
    // A wait outstanding when the window regains focus is polled immediately,
    // so returning to VS Code after merging does not cost a poll interval.
    window.onDidChangeWindowState((state) => { if (state.focused && autoRun.state()?.waiting === true) autoRun.continueNow(); }),
  );
  // Resume is explicit, never automatic (§11). Auto-resuming would launch a
  // write-capable agent into a workspace nobody has looked at since the crash,
  // with no human present — exactly what the visibility invariants prevent.
  const offerAutoRunResume = async (): Promise<void> => {
    const record = await new FileAutoRunStore(workspaceRoot).load().catch(() => undefined);
    if (record === undefined) return;
    const choice = await window.showWarningMessage(
      `An aboard auto-run for spec #${record.specNumber} was interrupted at the ${record.phase} phase of issue #${record.currentIssue ?? "?"}. Resume it?`,
      { modal: false },
      "Resume", "Discard",
    );
    if (choice === "Resume") {
      const result = await autoRun.resume(record).catch((error: unknown) => ({ started: false, reason: error instanceof Error ? error.message : "resume failed" }) as const);
      if (!result.started) void window.showErrorMessage(`aboard could not resume the run: ${result.reason}.`);
    } else if (choice === "Discard") {
      await new FileAutoRunStore(workspaceRoot).clear();
    }
  };
  void offerAutoRunResume();
  const reloadConfiguration = (restartHint: (before: typeof currentConfiguration, after: typeof currentConfiguration) => boolean) => {
    const next = configuration(projectSettings.values);
    const previous = currentConfiguration;
    currentConfiguration = next.value;
    for (const diagnostic of [...projectSettings.diagnostics, ...next.diagnostics]) output.appendLine(`Configuration: ${diagnostic.message}`);
    if (restartHint(previous, next.value)) void window.showInformationMessage("Manager launch settings changed. Restart the Manager to apply them.");
  };
  context.subscriptions.push(workspace.onDidChangeConfiguration((event) => {
    if (!ABOARD_SETTINGS.some((setting) => event.affectsConfiguration(setting))) return;
    reloadConfiguration(() => [...MANAGER_RESTART_SETTINGS].some((setting) => event.affectsConfiguration(setting)));
  }));
  // `.aboard/settings.json` is outside VS Code's settings model, so it needs its
  // own watcher; the broader `.aboard/**` scaffold watcher is not reused because
  // runtime writes would reload the file constantly.
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
  return { bridgeDiscoveryPath: discovery.path };
}

export async function deactivate(): Promise<void> {
  // Stopping is a pause with no resume promise: nothing is rolled back, and the
  // persisted record is what an explicit resume re-enters from.
  activeAutoRun?.stop("the extension is shutting down");
  await activeAutoRun?.settle();
  activeAutoRun = undefined;
  await persistence?.dispose();
  persistence = undefined;
  await bridge?.stop();
  bridge = undefined;
}
