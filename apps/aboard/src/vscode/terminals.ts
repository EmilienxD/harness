import { ConfigurationTarget, ThemeIcon, commands, window, workspace, type ViewColumn } from "vscode";

import type { TerminalHost } from "../platform/terminals.js";

export function captureEditorPanes(): readonly object[] { return [...window.tabGroups.all]; }

/** Keep terminal panes open to files without changing manual locks or other editor types. */
export async function prepareAgentTerminalGroups(): Promise<void> {
  const configuration = workspace.getConfiguration("workbench.editor");
  const autoLockGroups = configuration.get<Record<string, boolean>>("autoLockGroups", {});
  if (autoLockGroups.terminal === false) return;
  await configuration.update("autoLockGroups", { ...autoLockGroups, terminal: false }, ConfigurationTarget.Workspace);
}

/** Apply the preset grid once for a layout launch; subsequent terminal launches keep it. */
export async function initializeAgentLayout(columns: number, rows: number): Promise<readonly object[]> {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 9) throw new Error("Agent layouts support one to nine panes");
  await commands.executeCommand("vscode.setEditorLayout", {
    orientation: 1,
    groups: Array.from({ length: rows }, () => ({ size: 1 / rows, groups: Array.from({ length: columns }, () => ({ size: 1 / columns })) })),
  });
  return captureEditorPanes();
}

function destinationPane(preferred: object | undefined): ViewColumn {
  return (window.tabGroups.all.find((group) => group === preferred) ?? window.tabGroups.activeTabGroup).viewColumn;
}

export function createVsCodeTerminalHost(): TerminalHost {
  return {
    // Leave agent titles to VS Code and the running process. titleTemplate is
    // proposed API and is discarded for ordinary packaged extensions.
    createTerminal: (options) => window.createTerminal({
      cwd: options.cwd,
      env: { ...options.env },
      ...(options.provider === undefined && options.editorPane === undefined ? {} : { location: { viewColumn: destinationPane(options.editorPane), preserveFocus: true } }),
      ...(options.provider === undefined ? {} : { iconPath: new ThemeIcon(options.provider === "claude" ? "claude" : "openai") }),
      // A fixed VS Code name masks the provider's own terminal title.
      ...(options.provider !== undefined || options.name === undefined ? {} : { name: options.name }),
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellArgs === undefined ? {} : { shellArgs: [...options.shellArgs] }),
    }),
    onDidCloseTerminal: (listener) => window.onDidCloseTerminal(listener),
  };
}
