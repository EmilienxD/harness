import { ThemeIcon, window } from "vscode";

import type { TerminalHost } from "../platform/terminals.js";

export function createVsCodeTerminalHost(): TerminalHost {
  return {
    // Leave agent titles to VS Code and the running process. titleTemplate is
    // proposed API and is discarded for ordinary packaged extensions.
    createTerminal: (options) => window.createTerminal({
      cwd: options.cwd,
      env: { ...options.env },
      ...(options.provider === undefined ? {} : { iconPath: new ThemeIcon(options.provider === "claude" ? "claude" : "openai") }),
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellArgs === undefined ? {} : { shellArgs: [...options.shellArgs] }),
    }),
    onDidCloseTerminal: (listener) => window.onDidCloseTerminal(listener),
  };
}
