import type { ExtensionContext } from "vscode";
import { ProgressLocation, RelativePattern, commands, window, workspace } from "vscode";
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
import { isNamedBuiltinAgentType, type TerminalId } from "./domain/contracts.js";
import { createVsCodeTerminalHost } from "./vscode/terminals.js";
import { FileManagerStore, ManagerLifecycle } from "./claude/manager.js";
import { sessionIsResumable } from "./claude/sessions.js";
import { TranscriptBackupStore } from "./claude/transcript-backup.js";
import { ClaudeCommandProbe, spawnCommandRunner } from "./claude/preflight.js";
import type { WorkerPermissionMode } from "./claude/launch.js";
import { GitHubBoundaryError, GitHubClient, ProcessGhExecutor } from "./github/client.js";
import { readScaffoldState, scaffoldProject } from "./scaffold/project.js";
import { createVendoredToolInstaller } from "./scaffold/vendored.js";
import { basename, join } from "node:path";
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
import { ABOARD_MCP_TOOL_PATTERN, createMcpHandler } from "./bridge/mcp.js";
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
} from "./bridge/session-lifecycle.js";
import { lockMarkerDirectory, lockMarkerPresent, sessionWrapperLayout, takeSessionExitRecord, watchLockMarkers, type SessionExitRecord } from "./runtime/lock-markers.js";
import { WorkspaceAgentIdCounter } from "./runtime/agent-id-counter.js";
import { PromptResolver } from "./claude/prompts.js";
import { GitHubDelegationPromptResolver } from "./github/prompt-adapter.js";
import { FileSystemPromptSpillStore } from "./claude/spill.js";
import { agentDefinitionPath, parseAgentDefinition, parseBuiltinAgentProfile, sanitizeAgentDefinition } from "./scaffold/agent-definition.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId as TerminalIdBrand } from "./domain/contracts.js";
import { ReviewCoordinator, type PullRequestOwnership, type ReviewTerminals } from "./github/review.js";

/** Generous worker proof-of-life window: cold starts include `uv` resolving the hook shim and the claude CLI boot. */
const STARTUP_PROOF_TIMEOUT_MS = 60_000;
const SESSION_LIVENESS_POLL_MS = 5_000;
import { registerReviewCommand } from "./vscode/review.js";
import { ProcessGitClient, type GitClient } from "./git/client.js";
import { AutoRunEngine, type AutoRunState, type PullRequestOwner } from "./auto/engine.js";
import { FileAutoRunStore } from "./runtime/persistence.js";
import { planSessionResume, resolveLaunchConfiguration, type LaunchConfiguration } from "./claude/launch.js";
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
 * The project's own baseline commands, so a Manager can name the check a worker
 * should run instead of guessing at one. Read from `package.json` because that
 * is where this project keeps them; an unreadable or scriptless project simply
 * contributes nothing, which the briefing renders as "no baseline checks".
 */
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

/**
 * The roadmap as both the session-start briefing and the periodic reminder need
 * it. One definition, because the two must render the same ids from the same
 * document: a second resolve path is exactly the sync bug the derived-id design
 * exists to avoid. No carrier is a fact about the repository, not a failure, so
 * it resolves to `undefined` rather than throwing.
 */
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

/**
 * Sources for the Manager's single SessionStart briefing. Each is independently
 * fallible by design: `ManagerBriefings` converts a rejection into a one-line
 * "unavailable" note, so one broken `gh` call degrades one section instead of
 * losing the whole block.
 */
function briefingSources(
  git: GitClient,
  github: GitHubClient,
  workspaceRoot: string,
  previousSessionAt: () => string | undefined,
  autoRunState: () => AutoRunState | undefined,
): BriefingSources {
  return {
    repository: async () => ({
      name: basename(workspaceRoot),
      defaultBranch: await git.defaultBranch(),
      checks: await repositoryChecks(workspaceRoot),
    }),
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
        specNumber: state.specNumber,
        specTitle: state.specTitle,
        phase: state.phase,
        currentIssue: state.currentIssue,
        completedCount: state.completedCount,
        chromeEnabled: state.chromeEnabled,
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
    // Named builtins resolve their prompt and tools from Claude Code. aboard's
    // metadata-only profile contributes only command, model, and effort.
    // Capability remains fixed by the upstream Explore contract.
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
    // The whole definition is carried into the launch: sanitized here, rewritten
    // by the planner into the per-launch runtime directory `--add-dir` points
    // at, and selected with `--agent`. One file, no second authority (see
    // `LaunchConfiguration`). `command:` is the one field that shapes the line's
    // *program* rather than its flags, replacing `aboard.launch.claudeCommand`
    // for this agent alone.
    const sanitized = sanitizeAgentDefinition(result.value);
    return resolveLaunchConfiguration({
      agentName: type,
      systemPrompt: sanitized.prompt,
      declaredTools: sanitized.tools,
      declaredDescription: sanitized.description,
      declaredColor: sanitized.color,
      extraFrontmatter: sanitized.extraFrontmatter,
      declaredModel: sanitized.model,
      declaredEffort: sanitized.effort,
      declaredCommand: sanitized.command,
    });
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
  let sessionLifecycle: SessionLifecycleService | undefined;
  const sessionProofs = new SessionStartupProofs();
  let initialized = false;
  // A `when` clause hides a palette command; it does not disable it. An invoked
  // side effect on an uninitialized project would launch agents into
  // unscaffolded state or recreate `.aboard/` behind the user's back — the very
  // thing the persistence layer refuses to do — so those handlers refuse too.
  const requireInitialized = (): boolean => {
    if (initialized) return true;
    void window.showInformationMessage("aboard is not initialized in this workspace. Initialize it from the Get Started view first.");
    return false;
  };
  const terminals = new TerminalController({
    host: createVsCodeTerminalHost(),
    environment: () => {
      if (bridgeEnvironment === undefined) throw new Error("Bridge is not ready");
      return {
        ...bridgeEnvironment,
        workspaceRoot,
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
      output.appendLine(`${label} (agent ${agentId}, session ${sessionId}) did not produce a SessionStart hook in time; closing the terminal as a failed launch.`);
      // The terminal is being killed under the user and takes any shell error
      // text with it — silence here was the original "extension believes the
      // manager is running" experience, just deferred by the timeout.
      void window.showWarningMessage(
        `aboard closed "${label}": Claude Code reported no session start within ${Math.round(timeoutMs / 1000)}s. The launch failed before Claude Code could begin, or the SessionStart hook never fired. Check aboard.launch.claudeCommand and the project's hook configuration; the aboard output channel has details.`,
      );
    },
    onLifecycleEvent: (event) => {
      // Watch the marker from the launch itself, not from SessionStart: the
      // window in between is exactly where a CLI that rejects its arguments
      // dies, and nothing else observes it.
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
  // Workspace-scoped and never reset: agent labels read as plain, strictly
  // increasing numbers so the user can see how many agents ran across the
  // project's whole life. Seeded from the fleet's highest numeric id, so an
  // upgrade never restarts past launches this scheme already made.
  const agentIdCounter = WorkspaceAgentIdCounter.load(storageRoot, () => fleet.list().map((session) => session.identity.agentId as string));
  const lease = new WriteLease();
  const managerStore = new FileManagerStore(workspaceRoot);
  const github = new GitHubClient(new ProcessGhExecutor(workspaceRoot));
  const recordedManager = await managerStore.load();
  // A recorded Manager keeps its id across restarts (identity stability). A
  // first-ever Manager falls back to the numeric counter so new projects
  // number their Manager too; a pre-upgrade recorded Manager keeps its UUID
  // until the user starts a new Manager.
  const managerAgentId = recordedManager?.agentId ?? agentIdCounter.next();
  // Claude Code sweeps session files older than `cleanupPeriodDays` every time
  // it starts and offers no way to disable that, so the one session aboard
  // resumes for the project's whole life needs a copy of its own.
  const transcripts = new TranscriptBackupStore({
    workspaceRoot,
    retain: () => currentConfiguration.managerTranscriptBackups,
    log: (message) => output.appendLine(message),
  });
  // A restart is the other moment the sweep may have run unobserved: back up
  // whatever the recorded Manager still has before aboard launches anything
  // that triggers the next one. No `.aboard/` is created behind the user's
  // back — a recorded Manager means the runtime directory already exists.
  if (recordedManager !== undefined) void transcripts.checkpoint(recordedManager.sessionId);
  const launchConfigurations = workerConfigurations(workspaceRoot);
  // Every command line that reads a file — a spilled prompt, an agent's system
  // prompt — gets it from here, so all of them land under `.aboard/runtime/`.
  const runtimeFiles = new FileSystemPromptSpillStore(workspaceRoot);
  const wrapperLayout = sessionWrapperLayout(workspaceRoot);
  // aboard types its launch into a shell it does not own and never sees the
  // command's exit status. Asking `claude --version` in a child process aboard
  // does own turns "the terminal is full of shell errors" into a refused launch
  // with a reason. Cached per command, so only the first launch pays.
  const claudeProbe = new ClaudeCommandProbe({ run: spawnCommandRunner(workspaceRoot) });
  // `sessionMonitor` is constructed below, after the settlement callbacks it
  // needs; the observer is only ever called from a launch, long after that.
  const coordinator = new DelegationCoordinator({ workspaceRoot, fleet, lease, terminals, sessions: { observe: (agentId) => sessionMonitor.observe(agentId) }, onStaleLeaseRecovered: (holder, observation) => { output.appendLine(`Reclaimed the write lease from ${holder.agentId} (held since ${holder.acquiredAt}): terminal ${observation.terminal}, session ${observation.session}.`); void window.showWarningMessage(`aboard reclaimed the write lease from ${holder.agentId}: its terminal and session are both gone.`); }, configurations: launchConfigurations, prompts: new GitHubDelegationPromptResolver(new PromptResolver({ github })), spills: runtimeFiles, managerAgentId, shell: process.platform === "win32" ? "powershell" : "git-bash", permissionMode: currentConfiguration.workerPermissionMode, disallowedTools: [ABOARD_MCP_TOOL_PATTERN], command: () => currentConfiguration.claudeCommand, effort: () => currentConfiguration.launchEffort, maxInlinePromptChars: currentConfiguration.maxInlinePromptChars, agentIdFactory: () => agentIdCounter.next(), sessionIdFactory: () => randomUUID() as SessionId, startupTimeoutMs: STARTUP_PROOF_TIMEOUT_MS, wrapper: wrapperLayout, preflight: (command) => claudeProbe.require(command) });
  lifecycle = new WorkerLifecycleReconciler({ fleet, lease, completions: coordinator, workingTree: new GitWorkingTreeInspector() });
  // A settled session leaves its terminal to be collected: the record the
  // fleet dropped still names an open terminal, and the next launch for the
  // same agent fails the one-live-terminal invariant until it is closed —
  // "agent already has a live aboard terminal" on relaunch was exactly that
  // leak. Releasing the record clears the invariant without touching the
  // terminal: ending the session and closing the shell are separate gestures,
  // and a user who pressed Ctrl+C twice kept the shell on purpose. Closing it
  // as well is opt-in. The terminal id comes from the terminal controller, not
  // the fleet: every caller here settles the fleet record first, so a fleet
  // lookup would find nothing and silently leak the terminal.
  const releaseAbandonedTerminal = (agentId: AgentId): void => {
    const terminalId = terminals.liveTerminalForAgent(agentId);
    if (terminalId === undefined) return;
    if (currentConfiguration.closeTerminalOnSessionEnd) {
      try { terminals.kill(terminalId); } catch { /* already closed */ }
      return;
    }
    terminals.release(terminalId);
  };
  /**
   * A launch that died on its way up. The Claude CLI printed its reason into
   * the terminal and exited before any session existed, so nothing downstream
   * would ever settle this agent: the fleet record would sit at `starting`
   * forever and the write lease with it. The terminal is left alone by default
   * precisely because it holds the error text the user needs to read.
   */
  const reportFailedLaunch = (agentId: AgentId, sessionId: SessionId, exit: SessionExitRecord | undefined): void => {
    const cause = exit?.error !== undefined
      ? `could not be started (${exit.error})`
      : `exited with code ${exit?.exitCode ?? "unknown"} before starting a session`;
    output.appendLine(`Launch failed for agent ${agentId} (session ${sessionId}): claude ${cause}. The terminal holds the error.`);
    // The launch is settled; the proof's timeout must not fire later and kill a
    // terminal whose error message is the whole point of keeping it.
    sessionProofs.cancel(agentId);
    const at = new Date().toISOString() as IsoTimestamp;
    if (fleet.get(agentId) !== undefined) {
      lease.releaseForTerminalOutcome(agentId, at, "launch failed before the session started");
      fleet.remove(agentId, at);
    }
    releaseAbandonedTerminal(agentId);
    void window.showWarningMessage(`aboard could not start Claude: it ${cause}. Check the terminal for the error.`);
  };
  // The wrapper's marker file is the strongest liveness source aboard owns:
  // the user can kill the TUI from inside while keeping the shell (`exit`,
  // double Ctrl+C), and only the marker poll spots them — the wrapper removes
  // the marker the moment its Claude child exits for any reason. Terminal
  // close still wins when it happens first; untracking there lets the monitor
  // skip agents the shell already reclaimed.
  const sessionMonitor = new SessionProcessMonitor({
    probe: lockMarkerPresent,
    debug: (message) => output.appendLine(`[liveness] ${message}`),
    onProcessEnded: (observation) => {
      // The exit record is consumed either way, so a spent one can never be
      // read back against a later launch of the same agent.
      const exit = takeSessionExitRecord(observation.lockFile);
      if (observation.phase === "launching") {
        reportFailedLaunch(observation.agentId, observation.sessionId, exit);
        return;
      }
      const session = fleet.get(observation.agentId);
      if (session === undefined) return;
      const at = new Date().toISOString() as IsoTimestamp;
      if (!reportsResult(session)) {
        lease.releaseForTerminalOutcome(observation.agentId, at, "agent session process ended");
        fleet.remove(observation.agentId, at);
        releaseAbandonedTerminal(observation.agentId);
        output.appendLine(`Session process for agent ${observation.agentId} ended`);
        return;
      }
      void lifecycle?.processEnded(observation)
        .then(() => releaseAbandonedTerminal(observation.agentId))
        .catch((error: unknown) => output.appendLine(`Process-end reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`));
    },
  });
  const settleCleared = (agentId: AgentId): void => {
    const session = fleet.get(agentId);
    if (session === undefined) return;
    const at = new Date().toISOString() as IsoTimestamp;
    // `/clear` ends the conversation while the TUI and terminal keep running.
    // The agent record is spent history; the user deliberately kept the TUI.
      if (!reportsResult(session)) {
        lease.releaseForTerminalOutcome(agentId, at, "agent session cleared");
        fleet.remove(agentId, at);
        releaseAbandonedTerminal(agentId);
        return;
      }
      // Result-delivering sessions settle with a graceful completed outcome: the
      // conversation ended on the user's terms, and any pending run completes
      // rather than hangs waiting for a Stop hook that a cleared TUI cannot fire.
      void lifecycle?.processEnded({ agentId, sessionId: session.sessionId })
        .then(() => releaseAbandonedTerminal(agentId))
        .catch((error: unknown) => output.appendLine(`Session-end reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`));
  };
  sessionLifecycle = new SessionLifecycleService({
    fleet,
    monitor: sessionMonitor,
    settlement: { settleCleared },
    lockPathFor: wrapperLayout.lockPathFor,
    onSessionStarted: (observation) => {
      output.appendLine(`Session ${observation.sessionId} for agent ${observation.agentId} started`);
    },
  });
  // The watch is the fast path — a marker deletion settles the agent within
  // milliseconds — and the interval only covers filesystems where watching is
  // unreliable, so it can stay coarse.
  sessionMonitor.start(SESSION_LIVENESS_POLL_MS);
  try {
    const markerWatch = watchLockMarkers(lockMarkerDirectory(workspaceRoot), () => sessionMonitor.poll());
    context.subscriptions.push({ dispose: () => markerWatch.dispose() });
  } catch (error) {
    output.appendLine(`Could not watch session lock markers; falling back to polling only. ${error instanceof Error ? error.message : "unknown error"}`);
  }
  activeSessionMonitor = sessionMonitor;
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
      // The definition is a precondition for reopening the session, not a
      // refinement of it: a resume re-passes the system prompt and the tool
      // list, so resuming without them would put a stock Claude Code session,
      // holding every default tool, in a pr-doctor's terminal. Failing here is
      // worse for the user than it used to be, and still better than that.
      const configuration = await launchConfigurations.get(owner.type);
      const plan = planSessionResume({
        agentId: owner.agentId,
        sessionId: owner.sessionId,
        agentType: owner.type,
        shell: process.platform === "win32" ? "powershell" : "git-bash",
        permissionMode: currentConfiguration.workerPermissionMode,
        // `review_pr` exists to hand the session back to the user, so the
        // resumed terminal is driven by them even when it owned an afk worker.
        attended: true,
        command: currentConfiguration.claudeCommand,
        configuration,
        disallowedTools: [ABOARD_MCP_TOOL_PATTERN],
        ...(currentConfiguration.launchEffort === undefined ? {} : { effort: currentConfiguration.launchEffort }),
        wrapper: wrapperLayout,
      });
      if (plan.agentDefinition !== undefined) await runtimeFiles.write(plan.agentDefinition);
      const at = new Date().toISOString() as IsoTimestamp;
      // No lease: `review_pr` reopens the session for the user to drive, with
      // no first message sent into it. Whatever the run held it released when
      // the agent finished, and re-taking it here would block the user's own
      // parallel work on the branch they asked to look at.
      const terminal = terminals.create({
        agentId: owner.agentId,
        sessionId: owner.sessionId,
        agentType: owner.type,
        issueNumbers: [owner.issueNumber],
        name: `aboard: resume pull request ${owner.prNumber}`,
        initialCommand: plan.commandLine,
        startupTimeoutMs: STARTUP_PROOF_TIMEOUT_MS,
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
    briefingSources(git, github, workspaceRoot, () => recordedManager?.updatedAt, () => autoRun.state()),
    fleet,
    lease,
    {
      write: async (slice: "state" | "roadmap", content: string) => {
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
  // The reminder reads GitHub live at delivery time rather than from a bridge
  // copy: at this span the calls are minutes apart, and a reminder must reflect
  // an edit the user made on their phone.
  const roadmapReminders = new RoadmapReminderService({ roadmap: roadmapBriefing(github) });
  const managerPrompts = new ManagerPromptService(fleet, coordinator, undefined, {
    startAutoRun: (options) => autoRun.start(options),
    reviewPullRequest: (focus) => reviews.review(focus === undefined ? {} : { focus }),
  }, terminals, roadmapReminders);
  const discovery = new FileBridgeDiscoveryPersistence(storageRoot);
  bridge = await startBridge({
    preferredPort: currentConfiguration.bridgePort,
    handler: combineHandlers(createMcpHandler(coordinator, { managerAgentId, services: { github, reviews, autoRun, log: (message) => output.appendLine(message) } }), createManagerHookRoutes(briefings, managerStop, managerPrompts, roadmapReminders, (agentId) => {
      // The fleet is what knows which session the Manager is currently on, and
      // an agent it no longer holds (the user deleted `.aboard/`, or this is
      // not the Manager) gets no copy — which is also what keeps a checkpoint
      // from recreating the runtime directory behind the user's back.
      const session = fleet.get(agentId);
      if (session?.identity.type === "manager") void transcripts.checkpoint(session.sessionId);
    }), createWorkerLifecycleRoutes(lifecycle), createWorkerHookRoutes(new WorkerHookService(fleet)), createSessionLifecycleRoutes({ service: sessionLifecycle, proofs: sessionProofs }), createTerminalRoutes(terminals)),
    persistence: discovery,
    logger: { info: (message) => output.appendLine(message), error: (message) => output.appendLine(`Error: ${message}`) },
  });
  bridgeEnvironment = { port: bridge.port, token: bridge.token };
  const fleetUi = registerNativeFleetUi(context, bridge.port, fleet, lease, terminals, () => initialized);
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
        ? `Waiting for you to merge the pull request for issue #${state.currentIssue ?? "?"}. Chrome ${state.chromeEnabled ? "on" : "off"}. Click to stop the run.`
        : `${state.phase} — issue #${state.currentIssue ?? "?"}. Chrome ${state.chromeEnabled ? "on" : "off"}. Click to stop the run.`;
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
    store: managerStore, terminals, workspaceRoot, files: runtimeFiles,
    shell: process.platform === "win32" ? "powershell" : "git-bash",
    disallowedTools: currentConfiguration.managerDisallowedTools,
    preflight: (command) => claudeProbe.require(command),
    command: () => currentConfiguration.claudeCommand,
    permissionMode: () => currentConfiguration.workerPermissionMode,
    effort: () => currentConfiguration.launchEffort,
    agentIdFactory: () => managerAgentId,
    isResumable: sessionIsResumable,
    restoreTranscript: (sessionId) => transcripts.restore(sessionId),
    wrapper: wrapperLayout,
  });
  const warnKey = "aboard.manager.permissionWarning";
  // The UI offers resume and new as separate actions, so the launch path never
  // has to interrupt with a "which did you mean?" prompt.
  const launch = async (mode: "resume" | "new") => {
    if (!requireInitialized()) return;
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
        const prior = fleet.get(terminal.agentId)!;
        if (["starting", "running", "awaiting-user"].includes(prior.lifecycle.status)) {
          fleet.reattach(terminal.agentId, { terminalId: terminal.terminalId, name: terminal.name }, startedAt, terminal.sessionId);
        } else {
          fleet.restart(terminal.agentId, { terminalId: terminal.terminalId, name: terminal.name }, startedAt, terminal.sessionId);
        }
      }
      fleet.transition(terminal.agentId, { status: "running", startedAt }, startedAt);
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to launch Manager"); }
    finally { await publishManagerState(); }
  };
  let fleetRestoreRunning = false;
  let autoRunResumeDeferred = false;
  const pausedPersistedSessions = (): readonly AgentSession[] => {
    const openTerminalIds = new Set(terminals.list().filter((terminal) => terminal.status === "open").map((terminal) => terminal.terminalId));
    return fleet.list().filter((session) =>
      ["starting", "running", "awaiting-user"].includes(session.lifecycle.status) && !openTerminalIds.has(session.terminal.terminalId),
    );
  };
  const publishFleetRestoreState = async (): Promise<void> => {
    await commands.executeCommand("setContext", "aboard.fleetRestoreAvailable", !fleetRestoreRunning && pausedPersistedSessions().length > 0);
    await commands.executeCommand("setContext", "aboard.fleetRestoreRunning", fleetRestoreRunning);
  };
  const restoreFleet = async (confirm = true): Promise<void> => {
    if (fleetRestoreRunning) return;
    if (!requireInitialized()) return;
    const sessions = [...pausedPersistedSessions()];
    if (sessions.length === 0) return;
    if (confirm) {
      const confirmation = await window.showInformationMessage(
        `Restore ${sessions.length} aboard session${sessions.length === 1 ? "" : "s"}? New terminals will open and Claude will resume each saved conversation.`,
        { modal: true, detail: "Restored workers are handed back to you; interrupted automatic workflows remain separate and explicit." },
        "Restore Fleet",
      );
      if (confirmation !== "Restore Fleet") return;
    }
    fleetRestoreRunning = true;
    await publishFleetRestoreState();
    const failures: string[] = [];
    try {
      await window.withProgress({ location: ProgressLocation.Notification, title: "Restoring aboard fleet" }, async (progress) => {
        let completed = 0;
        const report = (session: AgentSession) => {
          completed += 1;
          progress.report({ message: `${session.identity.type} (${completed}/${sessions.length})` });
        };
        const managerSession = sessions.find((session) => session.identity.type === "manager");
        if (managerSession !== undefined) {
          try {
            const terminal = await manager.start("resume");
            const startedAt = new Date().toISOString() as IsoTimestamp;
            fleet.reattach(managerSession.identity.agentId, { terminalId: terminal.terminalId, name: terminal.name }, startedAt, terminal.sessionId);
            fleet.transition(managerSession.identity.agentId, { status: "running", startedAt }, startedAt);
          } catch (error) {
            failures.push(`Manager: ${error instanceof Error ? error.message : "restore failed"}`);
          }
          report(managerSession);
        }
        for (const session of sessions) {
          if (session.identity.type === "manager") continue;
          try { await coordinator.resumePersisted(session); }
          catch (error) { failures.push(`${session.identity.type}: ${error instanceof Error ? error.message : "restore failed"}`); }
          report(session);
        }
      });
    } finally {
      fleetRestoreRunning = false;
      await publishFleetRestoreState();
    }
    const restored = sessions.filter((session) => terminals.liveTerminalForAgent(session.identity.agentId) !== undefined);
    const terminalToShow = restored.find((session) => session.identity.type === "manager") ?? restored[0];
    if (terminalToShow !== undefined) terminals.show(fleet.get(terminalToShow.identity.agentId)!.terminal.terminalId);
    if (failures.length > 0) void window.showWarningMessage(`aboard restored ${sessions.length - failures.length} of ${sessions.length} sessions. ${failures.join("; ")}`);
    else void window.showInformationMessage(`aboard restored all ${sessions.length} sessions.`);
    if (autoRunResumeDeferred) void offerAutoRunResume();
  };
  void publishFleetRestoreState();
  if (pausedPersistedSessions().length > 0) {
    void window.showInformationMessage(
      `aboard paused ${pausedPersistedSessions().length} saved session${pausedPersistedSessions().length === 1 ? "" : "s"} when VS Code closed.`,
      "Restore Fleet",
    ).then((choice) => { if (choice === "Restore Fleet") void restoreFleet(false); });
  }
  // `aboard.initialized` drives the welcome view and the Initialize/Update pair.
  // `aboard.managerLive` hides the launch actions while a Manager is running, and
  // `aboard.managerResumable` shows Resume only when a session exists to resume.
  const publishManagerState = async () => {
    const recorded = await managerStore.load().catch(() => undefined);
    await commands.executeCommand("setContext", "aboard.managerLive", fleet.list().some((entry) => entry.identity.type === "manager"));
    await commands.executeCommand("setContext", "aboard.managerResumable", recorded !== undefined);
    await publishFleetRestoreState();
  };
  const publishScaffoldState = async () => {
    const state = await readScaffoldState(workspaceRoot).catch(() => "uninitialized" as const);
    const next = state === "initialized";
    // `.aboard/` is the project's state root. When it disappears the aboard
    // session it described is gone: live terminals are closed and the fleet is
    // discarded, rather than leaving the tree showing agents whose backing state
    // no longer exists. The auto-run is stopped first: its loop persists a
    // resume record as it advances, and left running it would recreate the
    // `.aboard/` the user just removed.
    if (initialized && !next) {
      autoRun.stop("project state was removed");
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
    fleetUi.refresh();
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
        installer: createVendoredToolInstaller(),
        ...(autoCompactEnabled === undefined ? {} : { autoCompactEnabled }),
      });
      for (const warning of report.warnings) { output.appendLine(`Warning: ${warning}`); void window.showWarningMessage(warning); }
      void window.showInformationMessage(`aboard ${first ? "initialized" : "updated"} (${report.created.length} created, ${report.updated.length} updated, ${report.removed.length} removed, ${report.preserved.length} preserved, ${report.installed.length} vendored tools installed).`);
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to scaffold aboard project assets"); }
    finally { await publishScaffoldState(); }
  };
  const startAutoRun = async (chrome: boolean): Promise<void> => {
    if (!requireInitialized()) return;
    try {
      const result = await autoRun.start(chrome ? { chrome: true } : {});
      if (!result.started) void window.showWarningMessage(`aboard cannot start an auto-run: ${result.reason}.`);
      else void window.showInformationMessage(`Auto-run started on spec #${result.spec.number} — ${result.issues.length} issue(s), review ${result.reviewMode ? "on" : "off"}, Chrome ${result.chromeEnabled ? "on" : "off"}.`);
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to start the auto-run"); }
  };
  context.subscriptions.push(
    commands.registerCommand("aboard.initializeProject", scaffold),
    commands.registerCommand("aboard.updateProject", async () => {
      if (!requireInitialized()) return;
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
    commands.registerCommand("aboard.restoreFleet", restoreFleet),
    registerReviewCommand({ registerCommand: (command, callback) => commands.registerCommand(command, (...args) => requireInitialized() ? callback(...args) : undefined), info: (message) => { void window.showInformationMessage(message); }, error: (message) => { void window.showErrorMessage(message); } }, reviews),
    commands.registerCommand("aboard.startAutoRun", () => startAutoRun(false)),
    commands.registerCommand("aboard.startAutoRunWithChrome", () => startAutoRun(true)),
    commands.registerCommand("aboard.stopAutoRun", () => autoRun.stop()),
    commands.registerCommand("aboard.continueAutoRun", () => autoRun.continueNow()),
    // A wait outstanding when the window regains focus is polled immediately,
    // so returning to VS Code after merging does not cost a poll interval.
    window.onDidChangeWindowState((state) => { if (state.focused && autoRun.state()?.waiting === true) autoRun.continueNow(); }),
  );
  // Resume is explicit, never automatic. Auto-resuming would launch a
  // write-capable agent into a workspace nobody has looked at since the crash,
  // with no human present — exactly what the visibility invariants prevent.
  const offerAutoRunResume = async (): Promise<void> => {
    const record = await new FileAutoRunStore(workspaceRoot).load().catch(() => undefined);
    if (record === undefined) { autoRunResumeDeferred = false; return; }
    const currentIssue = record.currentIssue;
    if (currentIssue !== undefined && pausedPersistedSessions().some((session) => session.identity.type !== "manager" && session.issueNumbers?.includes(currentIssue) === true)) {
      autoRunResumeDeferred = true;
      output.appendLine(`Auto-run resume for issue #${record.currentIssue ?? "?"} is deferred until its paused fleet session is restored or closed.`);
      return;
    }
    autoRunResumeDeferred = false;
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
  context.subscriptions.push(fleet.onDidChange(() => {
    if (autoRunResumeDeferred && !fleetRestoreRunning) void offerAutoRunResume();
  }));
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

let activeSessionMonitor: SessionProcessMonitor | undefined;

export async function deactivate(): Promise<void> {
  // Stopping is a pause with no resume promise: nothing is rolled back, and the
  // persisted record is what an explicit resume re-enters from.
  activeSessionMonitor?.stop();
  activeSessionMonitor = undefined;
  activeAutoRun?.stop("the extension is shutting down");
  await activeAutoRun?.settle();
  activeAutoRun = undefined;
  await persistence?.dispose();
  persistence = undefined;
  await bridge?.stop();
  bridge = undefined;
}
