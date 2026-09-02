import { EventEmitter, ProgressLocation, ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri, commands, env, window, workspace, type Disposable, type ExtensionContext, type TreeDataProvider } from "vscode";

import type { TerminalId } from "../domain/contracts.js";

import type { TerminalController } from "../claude/terminals.js";
import type { FleetRegistry } from "../domain/fleet.js";
import type { WriteLease } from "../domain/lease.js";
import { FleetNotifications, FleetTreeModel, LeaseSaveWarnings, registerFleetCommands, renderFleetStatus, type FleetTreeNode } from "./fleet.js";
import { AutoRunForecastController, AutoRunTreeModel, autoRunCard, autoRunCardMenuState, cardPullRequest, cardRecord, type AutoRunNode, type AutoRunPreview, type AutoRunViewSources } from "./auto-run.js";
import { ActivityTreeModel, canOpenActivityIssue, clearActivityWarning, type ActivityNode } from "./activity.js";
import type { ActivityDto, ActivityEntry } from "../domain/activity.js";
import type { AutoRunEngine, AutoRunPreviewedStartResult } from "../auto/engine.js";
import type { DiscardBehavior } from "../domain/run-cleanup.js";
import { describeDiscard } from "../domain/run-cleanup.js";

const AUTO_RUN_POLL_MS = 30_000;

export interface NativeFleetUiRegistration extends Disposable {
  /** Re-renders status-bar visibility; call it whenever the project's initialized state changes. */
  readonly refresh: () => void;
  /** Marks an idle forecast stale, or rechecks a visible recorded run. */
  readonly checkAutoRun: () => void;
}

export interface AutoRunUiHost {
  readonly engine: AutoRunEngine;
  readonly discardBehavior: () => DiscardBehavior;
  /** Opens an issue or pull request in the browser. */
  readonly webUrl: (number: number) => Promise<string>;
  readonly start: (preview: AutoRunPreview) => Promise<AutoRunPreviewedStartResult>;
}

export interface ActivityUiHost {
  readonly entries: () => readonly ActivityEntry[];
  readonly store: () => ActivityDto | undefined;
  readonly clear: () => Promise<void>;
  readonly reopen: (entry: ActivityEntry) => Promise<void>;
  readonly showTerminal: (entry: ActivityEntry) => void;
  /** Fires whenever an entry is appended or the store is cleared. */
  readonly onDidChange: (listener: () => void) => Disposable;
}

export interface NativeUiOptions {
  readonly port: () => number | undefined;
  readonly fleet: FleetRegistry;
  readonly lease: WriteLease;
  readonly terminals: TerminalController;
  readonly isInitialized: () => boolean;
  readonly autoRun: AutoRunUiHost;
  readonly activity: ActivityUiHost;
}

export function registerNativeFleetUi(context: ExtensionContext, options: NativeUiOptions): NativeFleetUiRegistration {
  const { fleet, lease, terminals, isInitialized } = options;
  const disposables: Disposable[] = [];
  const isTerminalOpen = (terminalId: string): boolean =>
    terminals.list().some((terminal) => terminal.terminalId === terminalId && terminal.status === "open");

  // -- Agent Fleet ------------------------------------------------------------
  const fleetChanges = new EventEmitter<FleetTreeNode | undefined>();
  const fleetModel = new FleetTreeModel(
    fleet,
    lease,
    { refresh: () => fleetChanges.fire(undefined) },
    (terminalId) => isTerminalOpen(terminalId),
    () => fleet.list().some((session) => session.identity.type === "manager"),
  );
  disposables.push(
    window.registerTreeDataProvider("aboard.fleet", {
      onDidChangeTreeData: fleetChanges.event,
      getChildren: (node) => [...(node === undefined ? fleetModel.roots() : fleetModel.children(node))],
      getTreeItem: (node) => {
        const mapped = fleetModel.item(node);
        const item = new TreeItem(mapped.label, mapped.collapsible ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
        item.description = mapped.description;
        item.tooltip = mapped.tooltip;
        item.contextValue = mapped.contextValue;
        item.iconPath = new ThemeIcon(mapped.icon);
        if (mapped.command) item.command = { ...mapped.command, arguments: [...mapped.command.arguments] };
        return item;
      },
    }),
    fleetChanges,
    fleetModel,
    // Hosts the pre-initialization presentation; never has rows of its own.
    window.registerTreeDataProvider("aboard.welcome", { getChildren: () => [], getTreeItem: (node: never) => node }),
  );

  // -- Auto Run ---------------------------------------------------------------
  const engine = options.autoRun.engine;
  let autoRunStarting = false;
  const forecast = new AutoRunForecastController(() => renderAutoRun());
  const implementerFor = (issueNumber: number): { readonly terminalId: TerminalId } | undefined => {
    for (const session of fleet.list()) {
      if (session.identity.type !== "implementer") continue;
      if (session.issueNumbers?.includes(issueNumber) !== true) continue;
      if (!isTerminalOpen(session.terminal.terminalId)) continue;
      return { terminalId: session.terminal.terminalId };
    }
    return undefined;
  };
  const autoRunSources: AutoRunViewSources = {
    starting: () => autoRunStarting,
    forecast: () => forecast.snapshot(),
    state: () => engine.state(),
    persisted: () => engine.persisted(),
    eligibility: () => engine.eligibility(),
    titles: () => engine.observedTitles(),
    hasLiveImplementer: (issueNumber) => implementerFor(issueNumber) !== undefined,
  };
  const autoRunModel = new AutoRunTreeModel(autoRunSources);
  const autoRunChanges = new EventEmitter<AutoRunNode | undefined>();
  const autoRunView = window.createTreeView<AutoRunNode>("aboard.autoRun", {
    treeDataProvider: {
      onDidChangeTreeData: autoRunChanges.event,
      getChildren: (node) => [...(node === undefined ? autoRunModel.roots() : autoRunModel.children(node))],
      getTreeItem: (node) => {
        const mapped = autoRunModel.item(node);
        const item = new TreeItem(mapped.label, mapped.collapsible ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None);
        item.description = mapped.description;
        item.tooltip = mapped.tooltip;
        item.contextValue = mapped.contextValue;
        item.iconPath = new ThemeIcon(mapped.icon);
        if (mapped.command) item.command = { ...mapped.command, arguments: [...mapped.command.arguments] };
        return item;
      },
    },
  });
  disposables.push(autoRunView, autoRunChanges);

  const publishAutoRunContext = async (): Promise<void> => {
    const card = autoRunCard(autoRunSources);
    await Promise.all([
      commands.executeCommand("setContext", "aboard.autoRunCard", autoRunCardMenuState(card)),
      commands.executeCommand("setContext", "aboard.autoRunHasPullRequest", cardPullRequest(card, engine.state()) !== undefined),
    ]);
  };
  const renderAutoRun = (): void => {
    // A frozen record supersedes the live forecast. Generation invalidation
    // prevents a slower GitHub read from putting that forecast back afterwards.
    if (engine.state() !== undefined || engine.persisted() !== undefined) {
      forecast.invalidate();
    }
    autoRunChanges.fire(undefined);
    void publishAutoRunContext();
  };
  renderAutoRun();

  const checkAutoRun = async (forceForecast = false): Promise<void> => {
    if (autoRunStarting) return;
    if (engine.state() !== undefined || engine.persisted() !== undefined) {
      await engine.refresh();
      return;
    }
    const snapshot = forecast.snapshot();
    if (!forceForecast && (snapshot.preview !== undefined || snapshot.checking || snapshot.error !== undefined)) return;
    await forecast.refresh(() => engine.dryRun());
  };

  /** Engine recovery checks and live forecasts each serialize overlapping triggers. */
  let poll: ReturnType<typeof setInterval> | undefined;
  const stopPolling = (): void => { if (poll !== undefined) { clearInterval(poll); poll = undefined; } };
  const startPolling = (): void => {
    if (poll !== undefined) return;
    poll = setInterval(() => {
      if (engine.state() !== undefined || engine.persisted() !== undefined) void checkAutoRun();
    }, AUTO_RUN_POLL_MS);
  };
  disposables.push({ dispose: stopPolling });
  disposables.push(autoRunView.onDidChangeVisibility((event) => {
    if (!event.visible) { stopPolling(); return; }
    void checkAutoRun();
    startPolling();
  }));
  disposables.push(window.onDidChangeWindowState((state) => {
    if (state.focused && autoRunView.visible && (engine.state() !== undefined || engine.persisted() !== undefined)) void checkAutoRun();
  }));
  if (autoRunView.visible) {
    void checkAutoRun();
    startPolling();
  }

  const openNumber = async (number: number | undefined): Promise<void> => {
    if (number === undefined) return;
    try { await env.openExternal(Uri.parse(await options.autoRun.webUrl(number))); }
    catch (error) { void window.showWarningMessage(`aboard could not open #${number}: ${error instanceof Error ? error.message : "unknown error"}`); }
  };

  const issueNumberOf = (value: unknown): number | undefined => {
    if (typeof value === "number") return value;
    if (typeof value === "object" && value !== null) {
      const node = value as { kind?: unknown; issue?: { number?: unknown } };
      if ((node.kind === "issue" || node.kind === "forecast-issue") && typeof node.issue?.number === "number") return node.issue.number;
    }
    return undefined;
  };

  disposables.push(
    commands.registerCommand("aboard.openIssue", (value: unknown) => void openNumber(issueNumberOf(value))),
    commands.registerCommand("aboard.openPullRequest", (value: unknown) => void openNumber(typeof value === "number" ? value : undefined)),
    commands.registerCommand("aboard.autoRun.refresh", async () => {
      await checkAutoRun(true);
      // A waiting run polls GitHub on its own interval; "Check Now" is the user
      // saying they have just merged and would rather not wait for it.
      if (engine.state()?.waiting === true) engine.continueNow();
    }),
    commands.registerCommand("aboard.autoRun.openCurrentIssue", () => {
      const record = cardRecord(autoRunCard(autoRunSources));
      void openNumber(engine.state()?.currentIssue ?? record?.currentIssue);
    }),
    commands.registerCommand("aboard.autoRun.openPullRequest", () => {
      void openNumber(cardPullRequest(autoRunCard(autoRunSources), engine.state()));
    }),
    commands.registerCommand("aboard.autoRun.focusImplementer", (value: unknown) => {
      const issueNumber = issueNumberOf(value);
      if (issueNumber === undefined) return;
      const implementer = implementerFor(issueNumber);
      if (implementer === undefined) return;
      terminals.show(implementer.terminalId);
    }),
    commands.registerCommand("aboard.startAutoRun", async () => {
      if (autoRunStarting) return;
      const card = autoRunCard(autoRunSources);
      if (card.kind !== "forecast" || autoRunCardMenuState(card) !== "forecast") return;
      autoRunStarting = true;
      renderAutoRun();
      try {
        const result = await options.autoRun.start(card.forecast.preview);
        if (!result.started) {
          if ("preview" in result) forecast.replace(result.preview);
          else forecast.fail(result.reason);
        }
      }
      finally {
        autoRunStarting = false;
        renderAutoRun();
      }
    }),
    commands.registerCommand("aboard.resumeAutoRun", async () => {
      // Revalidated immediately before launching: the panel state may have gone
      // stale between the poll that enabled this action and the click.
      const eligibility = await engine.refresh();
      if (eligibility?.state !== "resumable") {
        void window.showWarningMessage(`aboard cannot resume that run: ${eligibility?.state === "broken" ? eligibility.reason : "its state is still being checked"}.`);
        return;
      }
      const result = await engine.resume();
      if (!result.started) void window.showErrorMessage(`aboard could not resume the run: ${result.reason}.`);
    }),
    commands.registerCommand("aboard.discardAutoRun", async () => {
      const behavior = options.autoRun.discardBehavior();
      const plan = await window.withProgress(
        { location: ProgressLocation.Window, title: "Checking auto-run cleanup…" },
        () => engine.planDiscard(behavior),
      );
      const confirmed = await window.showWarningMessage(
        `Discard this auto-run? (aboard.autoRun.discardBehavior: ${behavior})`,
        { modal: true, detail: describeDiscard(plan) },
        "Discard",
      );
      if (confirmed !== "Discard") return;
      const result = await window.withProgress(
        { location: ProgressLocation.Window, title: "Discarding auto-run…" },
        () => engine.discard(behavior),
      );
      const removed = [
        ...result.deletedLocalBranches.map((branch) => `local ${branch}`),
        ...result.deletedRemoteBranches.map((branch) => `origin/${branch}`),
        ...result.closedPullRequests.map((number) => `PR #${number}`),
      ];
      void window.showInformationMessage(
        `Auto-run discarded${removed.length === 0 ? "" : `; removed ${removed.join(", ")}`}.`
        + (result.leftovers.length === 0 ? "" : ` Left in place: ${result.leftovers.join("; ")}.`),
      );
    }),
  );

  // -- Recent Activity --------------------------------------------------------
  const activityModel = new ActivityTreeModel({
    entries: () => options.activity.entries(),
    isTerminalOpen: (terminalId) => isTerminalOpen(terminalId),
  });
  const activityChanges = new EventEmitter<ActivityNode | undefined>();
  disposables.push(
    window.registerTreeDataProvider("aboard.recentActivity", {
      onDidChangeTreeData: activityChanges.event,
      getChildren: (node) => [...(node === undefined ? activityModel.roots() : [])],
      getTreeItem: (node) => {
        const mapped = activityModel.item(node);
        const item = new TreeItem(mapped.label, TreeItemCollapsibleState.None);
        item.description = mapped.description;
        item.tooltip = mapped.tooltip;
        item.contextValue = mapped.contextValue;
        item.iconPath = new ThemeIcon(mapped.icon);
        if (mapped.command) item.command = { ...mapped.command, arguments: [...mapped.command.arguments] };
        return item;
      },
    }),
    activityChanges,
    options.activity.onDidChange(() => activityChanges.fire(undefined)),
    commands.registerCommand("aboard.activity.openTerminal", (node: unknown) => {
      const entry = activityEntryOf(node);
      if (entry !== undefined) options.activity.showTerminal(entry);
    }),
    commands.registerCommand("aboard.activity.openIssue", (node: unknown) => {
      const entry = activityEntryOf(node);
      if (entry !== undefined && canOpenActivityIssue(entry)) void openNumber(entry.issueNumbers[0]);
    }),
    commands.registerCommand("aboard.activity.openPullRequest", (node: unknown) => {
      void openNumber(activityEntryOf(node)?.pullRequest);
    }),
    commands.registerCommand("aboard.activity.reopen", async (node: unknown) => {
      const entry = activityEntryOf(node);
      if (entry === undefined) return;
      try { await options.activity.reopen(entry); }
      catch (error) { void window.showErrorMessage(`aboard could not reopen that session: ${error instanceof Error ? error.message : "unknown error"}`); }
    }),
    commands.registerCommand("aboard.activity.clear", async () => {
      const warning = clearActivityWarning(options.activity.store());
      const confirmed = await window.showWarningMessage(
        "Clear recent activity?",
        { modal: true, ...(warning === undefined ? {} : { detail: warning }) },
        "Clear All",
      );
      if (confirmed !== "Clear All") return;
      await options.activity.clear();
    }),
  );

  // -- Shared -----------------------------------------------------------------
  const commandRegistration = registerFleetCommands({
    register: (command, callback) => commands.registerCommand(command, callback),
    confirm: async (message, action) => await window.showWarningMessage(message, { modal: true }, action) === action,
    info: (message) => { void window.showInformationMessage(message); },
    error: (message) => { void window.showErrorMessage(message); },
  }, {
    show: (terminalId) => terminals.show(terminalId),
    kill: (terminalId) => terminals.kill(terminalId),
    isOpen: (terminalId) => isTerminalOpen(terminalId),
  }, fleet, lease);
  disposables.push(commandRegistration);

  const notifications = new FleetNotifications(fleet, {
    warning: (message) => { void window.showWarningMessage(message); },
    error: (message) => { void window.showErrorMessage(message); },
  });
  disposables.push(notifications);

  const status = window.createStatusBarItem(undefined, 100);
  status.command = "aboard.focusFleet";
  const render = () => {
    renderAutoRun();
    if (!isInitialized()) { status.hide(); return; }
    const snapshot = renderFleetStatus(options.port() ?? 0, fleet, lease, (terminalId) => isTerminalOpen(terminalId), engine.state());
    status.text = snapshot.text;
    status.tooltip = snapshot.tooltip;
    status.show();
  };
  render();
  disposables.push(status, fleet.onDidChange(render), lease.onDidChange(render));
  disposables.push(commands.registerCommand("aboard.focusFleet", () => commands.executeCommand("aboard.fleet.focus")));

  const leaseSaveWarnings = new LeaseSaveWarnings();
  disposables.push(workspace.onDidSaveTextDocument(() => {
    const warning = leaseSaveWarnings.next(lease);
    if (warning !== undefined) void window.showWarningMessage(warning);
  }));

  const registration: NativeFleetUiRegistration = {
    refresh: render,
    checkAutoRun: () => {
      if (engine.state() === undefined && engine.persisted() === undefined) {
        forecast.markStale();
        renderAutoRun();
        return;
      }
      if (autoRunView.visible) void checkAutoRun();
    },
    dispose: () => { for (const disposable of [...disposables].reverse()) disposable.dispose(); },
  };
  context.subscriptions.push(registration);
  return registration;
}

function activityEntryOf(value: unknown): ActivityEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const node = value as { kind?: unknown; entry?: unknown };
  return node.kind === "activity" ? node.entry as ActivityEntry : undefined;
}
