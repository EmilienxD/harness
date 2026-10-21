import { ConfigurationTarget, TabInputTerminal, ThemeIcon, commands, window, workspace, type TabGroup, type Terminal, type ViewColumn } from "vscode";

import type { TerminalHost } from "../platform/terminals.js";

export function captureEditorPanes(): readonly object[] { return [...window.tabGroups.all]; }

/** Bound editor tab widths and keep terminal panes open to files without changing manual locks. */
export async function prepareAgentTerminalGroups(): Promise<void> {
  const configuration = workspace.getConfiguration("workbench.editor");
  const autoLockGroups = configuration.get<Record<string, boolean>>("autoLockGroups", {});
  if (autoLockGroups.terminal !== false) {
    await configuration.update("autoLockGroups", { ...autoLockGroups, terminal: false }, ConfigurationTarget.Workspace);
  }
  // Native ellipsis preserves full session titles and respects the user's fixed
  // min/max widths (160px maximum by default), without provider-specific slicing.
  if (configuration.get<string>("tabSizing") !== "fixed") {
    await configuration.update("tabSizing", "fixed", ConfigurationTarget.Workspace);
  }
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

/**
 * The editor group showing a terminal. VS Code exposes no terminal-to-tab
 * mapping, so reveal the terminal and read the group VS Code activates for it.
 * Undefined means no other group was activated: the terminal is in the active
 * group or the panel, and callers fall back to the active group.
 */
export async function terminalPane(terminal: Terminal, timeoutMs = 1_000): Promise<TabGroup | undefined> {
  const showing = () => window.activeTerminal === terminal && window.tabGroups.activeTabGroup.activeTab?.input instanceof TabInputTerminal;
  // A new terminal becomes active even in the panel, so only an editor terminal
  // whose title is on the active tab is taken as already shown; any other
  // reveal is observed below.
  const location = "location" in terminal.creationOptions ? terminal.creationOptions.location : undefined;
  if (showing() && typeof location === "object" && "viewColumn" in location && window.tabGroups.activeTabGroup.activeTab?.label === terminal.name) return window.tabGroups.activeTabGroup;
  const before = window.tabGroups.activeTabGroup;
  return new Promise((resolve) => {
    const subscriptions: { dispose(): void }[] = [];
    const finish = (group: TabGroup | undefined) => {
      clearTimeout(timer);
      for (const subscription of subscriptions) subscription.dispose();
      resolve(group);
    };
    // Terminal focus and group activation arrive as separate events, while
    // starting terminals flip active tabs within groups. Only the group
    // activation identifies the terminal's own group.
    const check = () => {
      if (showing() && window.tabGroups.activeTabGroup !== before) finish(window.tabGroups.activeTabGroup);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    subscriptions.push(window.onDidChangeActiveTerminal(check), window.tabGroups.onDidChangeTabGroups(check));
    terminal.show(false);
  });
}

function destinationPane(preferred: object | undefined): ViewColumn {
  return (window.tabGroups.all.find((group) => group === preferred) ?? window.tabGroups.activeTabGroup).viewColumn;
}

export function createVsCodeTerminalHost(): TerminalHost {
  const titles = new WeakMap<Terminal, string>();
  const applyTitle = (terminal: Terminal | undefined): void => {
    if (terminal === undefined) return;
    void Promise.resolve(terminal.processId).then(async () => {
      const name = titles.get(terminal);
      if (terminal.exitStatus !== undefined || name === undefined || terminal.name === name) return;
      // Wait for creation before using the active-only stable rename command.
      // Never reveal a background terminal merely to rename it.
      if (window.activeTerminal === terminal) await commands.executeCommand("workbench.action.terminal.renameWithArg", { name });
    }).catch((error: unknown) => console.error("Aboard terminal rename failed", error));
  };
  const activeRegistration = window.onDidChangeActiveTerminal(applyTitle);
  return {
    createTerminal: (options) => window.createTerminal({
      cwd: options.cwd,
      env: { ...options.env },
      ...(options.provider === undefined && options.editorPane === undefined ? {} : { location: { viewColumn: destinationPane(options.editorPane), preserveFocus: true } }),
      ...(options.provider === undefined ? {} : { iconPath: new ThemeIcon(({ claude: "claude", chatgpt: "openai", pi: "aboard-pi" } as const)[options.provider]) }),
      // Own the label so OSC titles cannot reintroduce wrapper names or logos.
      // VS Code 1.141+ hides the icon of narrow editor tabs, which includes a bare "Pi".
      ...(options.provider === undefined
        ? options.name === undefined ? {} : { name: options.name }
        : { name: ({ claude: "Claude Code", chatgpt: "Codex", pi: "Pi Agent" } as const)[options.provider] }),
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellArgs === undefined ? {} : { shellArgs: [...options.shellArgs] }),
    }),
    setTitle: (handle, name) => {
      const terminal = window.terminals.find((candidate) => candidate === handle);
      if (terminal === undefined) return;
      titles.set(terminal, name);
      applyTitle(terminal);
    },
    onDidCloseTerminal: (listener) => {
      const closed = window.onDidCloseTerminal(listener);
      return { dispose: () => { closed.dispose(); activeRegistration.dispose(); } };
    },
    editorPaneOf: async (handle) => {
      const terminal = window.terminals.find((candidate) => candidate === handle);
      return terminal === undefined ? undefined : terminalPane(terminal);
    },
  };
}
