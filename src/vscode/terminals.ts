import { window, type TerminalOptions } from "vscode";

import type { TerminalHost } from "../claude/terminals.js";

export function createVsCodeTerminalHost(): TerminalHost {
  return {
    createTerminal: (options) => {
      // VS Code supports this field at runtime from our minimum version, but it
      // has not yet moved from the terminalTitle proposal into TerminalOptions.
      // Isolate that typing gap here; every other layer treats it explicitly.
      const creationOptions: TerminalOptions & { readonly titleTemplate?: string } = {
        cwd: options.cwd,
        env: { ...options.env },
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.titleTemplate === undefined ? {} : { titleTemplate: options.titleTemplate }),
        ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
        ...(options.shellArgs === undefined ? {} : { shellArgs: [...options.shellArgs] }),
      };
      return window.createTerminal(creationOptions);
    },
    onDidCloseTerminal: (listener) => window.onDidCloseTerminal(listener),
  };
}
