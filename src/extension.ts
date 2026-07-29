import type { ExtensionContext } from "vscode";
import { window, workspace } from "vscode";
import { randomUUID } from "node:crypto";

import {
  FileBridgeDiscoveryPersistence,
} from "./bridge/discovery.js";
import {
  DEFAULT_BRIDGE_PORT,
  startBridge,
  type BridgeRuntime,
} from "./bridge/server.js";
import { createTerminalRoutes } from "./bridge/terminal-routes.js";
import { TerminalController } from "./claude/terminals.js";
import type { TerminalId } from "./domain/contracts.js";
import { createVsCodeTerminalHost } from "./vscode/terminals.js";

let bridge: BridgeRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot === undefined) return;

  const output = window.createOutputChannel("aboard");
  context.subscriptions.push(output);
  let bridgeEnvironment: { port: number; token: string } | undefined;
  const terminals = new TerminalController({
    host: createVsCodeTerminalHost(),
    environment: () => {
      if (bridgeEnvironment === undefined) throw new Error("Bridge is not ready");
      return { ...bridgeEnvironment, workspaceRoot };
    },
    terminalIdFactory: () => randomUUID() as TerminalId,
    onLifecycleEvent: (event) => {
      if (event.type === "terminal-closed") {
        output.appendLine(`Terminal ${event.terminalId} closed (${event.reason}, exit ${event.exitCode ?? "unknown"})`);
      }
    },
  });
  context.subscriptions.push({ dispose: () => terminals.dispose() });
  bridge = await startBridge({
    preferredPort: workspace
      .getConfiguration("aboard.bridge")
      .get<number>("port", DEFAULT_BRIDGE_PORT),
    handler: createTerminalRoutes(terminals),
    persistence: new FileBridgeDiscoveryPersistence(workspaceRoot),
    logger: {
      info: (message) => output.appendLine(message),
      error: (message) => output.appendLine(`Error: ${message}`),
    },
  });
  bridgeEnvironment = { port: bridge.port, token: bridge.token };
  context.subscriptions.push({ dispose: () => void bridge?.stop() });
}

export async function deactivate(): Promise<void> {
  await bridge?.stop();
  bridge = undefined;
}
