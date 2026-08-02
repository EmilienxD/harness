import { EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState, commands, window, workspace, type Disposable, type ExtensionContext, type TreeDataProvider } from "vscode";

import type { TerminalController } from "../claude/terminals.js";
import type { FleetRegistry } from "../domain/fleet.js";
import type { WriteLease } from "../domain/lease.js";
import { FleetNotifications, FleetTreeModel, registerFleetCommands, renderFleetStatus, saveLeaseWarning, type FleetTreeNode } from "./fleet.js";

export interface NativeFleetUiRegistration extends Disposable {
  /** Re-renders status-bar visibility; call it whenever the project's initialized state changes. */
  readonly refresh: () => void;
}

export function registerNativeFleetUi(context: ExtensionContext, port: number, fleet: FleetRegistry, lease: WriteLease, terminals: TerminalController, isInitialized: () => boolean): NativeFleetUiRegistration {
  const disposables: Disposable[] = [];
  const changes = new EventEmitter<FleetTreeNode | undefined>();
  const model = new FleetTreeModel(
    fleet,
    lease,
    { refresh: () => changes.fire(undefined) },
    () => new Date(),
    (terminalId) => terminals.list().some((terminal) => terminal.terminalId === terminalId && terminal.status === "open"),
  );
  const provider = (roots: () => readonly FleetTreeNode[]): TreeDataProvider<FleetTreeNode> => ({
    onDidChangeTreeData: changes.event,
    getChildren: (node) => [...(node === undefined ? roots() : model.children(node))],
    getTreeItem: (node) => {
      const mapped = model.item(node);
      const item = new TreeItem(mapped.label, mapped.collapsible ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
      item.description = mapped.description;
      item.tooltip = mapped.tooltip;
      item.contextValue = mapped.contextValue;
      item.iconPath = new ThemeIcon(mapped.icon);
      if (mapped.command) item.command = { ...mapped.command, arguments: [...mapped.command.arguments] };
      return item;
    },
  });
  // One section over the whole model: the Manager sorts first, workers follow.
  // Its welcome view renders only while the tree is empty, so the launch actions
  // also live in the view title menu, where a leftover worker row cannot hide them.
  disposables.push(
    window.registerTreeDataProvider("aboard.fleet", provider(() => model.roots())),
    changes,
    model,
    // Hosts the pre-initialization presentation; never has rows of its own.
    window.registerTreeDataProvider("aboard.welcome", { getChildren: () => [], getTreeItem: (node: never) => node }),
  );

  const commandRegistration = registerFleetCommands({
    register: (command, callback) => commands.registerCommand(command, callback),
    confirm: async (message, action) => await window.showWarningMessage(message, { modal: true }, action) === action,
    info: (message) => { void window.showInformationMessage(message); },
    error: (message) => { void window.showErrorMessage(message); },
  }, {
    show: (terminalId) => terminals.show(terminalId),
    kill: (terminalId) => terminals.kill(terminalId),
    isOpen: (terminalId) => terminals.list().some((terminal) => terminal.terminalId === terminalId && terminal.status === "open"),
  }, fleet, lease);
  disposables.push(commandRegistration);

  const notifications = new FleetNotifications(fleet, {
    information: (message) => { void window.showInformationMessage(message); },
    warning: (message) => { void window.showWarningMessage(message); },
    error: (message) => { void window.showErrorMessage(message); },
  });
  disposables.push(notifications);

  const status = window.createStatusBarItem(undefined, 100);
  status.command = "aboard.focusFleet";
  // An uninitialized project shows only the welcome view with its Initialize
  // button: the bridge status is aboard state, and none of it may surface
  // before the user has asked for a `.aboard/`.
  const render = () => {
    if (!isInitialized()) { status.hide(); return; }
    const snapshot = renderFleetStatus(port, fleet, lease);
    status.text = snapshot.text;
    status.tooltip = snapshot.tooltip;
    status.show();
  };
  render();
  disposables.push(status, fleet.onDidChange(render), lease.onDidChange(render));
  disposables.push(commands.registerCommand("aboard.focusFleet", () => commands.executeCommand("aboard.fleet.focus")));

  disposables.push(workspace.onDidSaveTextDocument(() => {
    const warning = saveLeaseWarning(lease);
    if (warning !== undefined) void window.showWarningMessage(warning);
  }));

  const registration: NativeFleetUiRegistration = { refresh: render, dispose: () => { for (const disposable of [...disposables].reverse()) disposable.dispose(); } };
  context.subscriptions.push(registration);
  return registration;
}
