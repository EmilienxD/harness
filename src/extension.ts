import type { ExtensionContext } from "vscode";
import { window, workspace } from "vscode";

import {
  FileBridgeDiscoveryPersistence,
} from "./bridge/discovery.js";
import {
  DEFAULT_BRIDGE_PORT,
  notFoundHandler,
  startBridge,
  type BridgeRuntime,
} from "./bridge/server.js";

let bridge: BridgeRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot === undefined) return;

  const output = window.createOutputChannel("aboard");
  context.subscriptions.push(output);
  bridge = await startBridge({
    preferredPort: workspace
      .getConfiguration("aboard.bridge")
      .get<number>("port", DEFAULT_BRIDGE_PORT),
    handler: notFoundHandler,
    persistence: new FileBridgeDiscoveryPersistence(workspaceRoot),
    logger: {
      info: (message) => output.appendLine(message),
      error: (message) => output.appendLine(`Error: ${message}`),
    },
  });
  context.subscriptions.push({ dispose: () => void bridge?.stop() });
}

export async function deactivate(): Promise<void> {
  await bridge?.stop();
  bridge = undefined;
}
