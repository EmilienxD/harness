import { window } from "vscode";

import type { TerminalHost } from "../platform/terminals.js";

export function createVsCodeTerminalHost(): TerminalHost {
  return {
    // Leave agent titles to VS Code and the running process. titleTemplate is
    // proposed API and is discarded for ordinary packaged extensions.
    createTerminal: (options) => window.createTerminal({
      cwd: options.cwd,
      env: { ...options.env },
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellArgs === undefined ? {} : { shellArgs: [...options.shellArgs] }),
    }),
    onDidCloseTerminal: (listener) => window.onDidCloseTerminal(listener),
  };
}
