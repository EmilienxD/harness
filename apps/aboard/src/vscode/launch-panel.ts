import type { Disposable } from "vscode";

/** The view whose only rows launch one provider each, above the fleet tree. */
export const LAUNCH_VIEW_ID = "aboard.launch";

export interface LaunchAction {
  /** A command contributed by this extension. */
  readonly command: string;
  readonly label: string;
  /** A codicon id; VS Code ships `claude` and `openai` with its own agent UI. */
  readonly icon: string;
  /** Matched by the `view/item/context` `when` clause that hangs the hover play button off this row. */
  readonly contextValue: string;
}

export const LAUNCH_ACTIONS: readonly LaunchAction[] = [
  { command: "aboard.runClaudeCode", label: "Run Claude Code", icon: "claude", contextValue: "aboard.launch.claude" },
  { command: "aboard.runCodex", label: "Run Codex", icon: "openai", contextValue: "aboard.launch.codex" },
];

/** One row, in the shape the call site maps onto a `TreeItem`. */
export interface LaunchRow {
  readonly label: string;
  readonly icon: string;
  readonly contextValue: string;
  readonly command: { readonly command: string; readonly title: string };
}

export interface LaunchPanelProvider {
  getChildren(node?: LaunchAction): readonly LaunchAction[];
  getTreeItem(node: LaunchAction): LaunchRow;
}

export interface LaunchPanelHost {
  registerTreeDataProvider(viewId: string, provider: LaunchPanelProvider): Disposable;
}

export function launchRow(action: LaunchAction): LaunchRow {
  // Clicking anywhere on the row is the whole interaction. The context value
  // only adds the inline play button that makes that clickable on hover; it
  // runs the same command the row itself carries.
  return {
    label: action.label,
    icon: action.icon,
    contextValue: action.contextValue,
    command: { command: action.command, title: action.label },
  };
}

export function registerLaunchPanel(host: LaunchPanelHost, actions: readonly LaunchAction[] = LAUNCH_ACTIONS): Disposable {
  return host.registerTreeDataProvider(LAUNCH_VIEW_ID, {
    // A fixed pair of leaf rows: the view never changes, so it needs no change event.
    getChildren: (node) => node === undefined ? actions : [],
    getTreeItem: launchRow,
  });
}
