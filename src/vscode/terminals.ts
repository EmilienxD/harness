import { window } from "vscode";

import type { TerminalHost } from "../claude/terminals.js";

export function createVsCodeTerminalHost(): TerminalHost {
  return {
    createTerminal: (options) => window.createTerminal({
      cwd: options.cwd,
      env: { ...options.env },
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellArgs === undefined ? {} : { shellArgs: [...options.shellArgs] }),
    }),
    onDidCloseTerminal: (listener) => window.onDidCloseTerminal(listener),
  };
}
