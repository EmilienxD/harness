import { EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState, commands, window, workspace, type Disposable, type ExtensionContext, type TreeDataProvider } from "vscode";

import type { TerminalController } from "../claude/terminals.js";
import type { FleetRegistry } from "../domain/fleet.js";
import type { WriteLease } from "../domain/lease.js";
import { FleetNotifications, FleetTreeModel, registerFleetCommands, renderFleetStatus, saveLeaseWarning, type FleetTreeNode } from "./fleet.js";

export function registerNativeFleetUi(context: ExtensionContext, port: number, fleet: FleetRegistry, lease: WriteLease, terminals: TerminalController): Disposable {
  const disposables: Disposable[] = [];
  const changes = new EventEmitter<FleetTreeNode | undefined>();
  const model = new FleetTreeModel(fleet, lease, { refresh: () => changes.fire(undefined) });
  const provider: TreeDataProvider<FleetTreeNode> = {
    onDidChangeTreeData: changes.event,
    getChildren: (node) => [...(node === undefined ? model.roots() : model.children(node))],
    getTreeItem: (node) => {
      const mapped = model.item(node);
      const item = new TreeItem(mapped.label, mapped.collapsible ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
      item.description = mapped.description;
      item.tooltip = mapped.tooltip;
      item.contextValue = mapped.contextValue;
      item.iconPath = new ThemeIcon(node.kind === "child" ? "symbol-method" : node.leaseHolder ? "lock" : "terminal");
      if (mapped.command) item.command = { ...mapped.command, arguments: [...mapped.command.arguments] };
      return item;
    },
  };
  disposables.push(window.registerTreeDataProvider("aboard.fleet", provider), changes, model);

  const commandRegistration = registerFleetCommands({
    register: (command, callback) => commands.registerCommand(command, callback),
    input: async (prompt) => window.showInputBox({ prompt, ignoreFocusOut: true }),
    confirm: async (message, action) => await window.showWarningMessage(message, { modal: true }, action) === action,
    info: (message) => { void window.showInformationMessage(message); },
    error: (message) => { void window.showErrorMessage(message); },
  }, terminals, fleet, lease);
  disposables.push(commandRegistration);

  const notifications = new FleetNotifications(fleet, {
    information: (message) => { void window.showInformationMessage(message); },
    warning: (message) => { void window.showWarningMessage(message); },
    error: (message) => { void window.showErrorMessage(message); },
  });
  disposables.push(notifications);

  const status = window.createStatusBarItem(undefined, 100);
  status.command = "aboard.focusFleet";
  const render = () => { const snapshot = renderFleetStatus(port, fleet, lease); status.text = snapshot.text; status.tooltip = snapshot.tooltip; status.show(); };
  render();
  disposables.push(status, fleet.onDidChange(render), lease.onDidChange(render));
  disposables.push(commands.registerCommand("aboard.focusFleet", () => commands.executeCommand("aboard.fleet.focus")));

  disposables.push(workspace.onDidSaveTextDocument(() => {
    const warning = saveLeaseWarning(lease);
    if (warning !== undefined) void window.showWarningMessage(warning);
  }));

  const registration = { dispose: () => { for (const disposable of [...disposables].reverse()) disposable.dispose(); } };
  context.subscriptions.push(registration);
  return registration;
}
