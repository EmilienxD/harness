import type { ExtensionContext } from "vscode";
import { commands, window, workspace } from "vscode";
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
import { FileManagerStore, ManagerLifecycle } from "./claude/manager.js";
import type { WorkerPermissionMode } from "./claude/launch.js";
import { GitHubBoundaryError, GitHubClient, ProcessGhExecutor } from "./github/client.js";
import { scaffoldProject } from "./scaffold/project.js";
import { join } from "node:path";

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
  const managerStore = new FileManagerStore(workspaceRoot);
  const github = new GitHubClient(new ProcessGhExecutor(workspaceRoot));
  const manager = new ManagerLifecycle({
    store: managerStore, terminals, workspaceRoot,
    shell: process.platform === "win32" ? "powershell" : "git-bash",
    preset: workspace.getConfiguration("aboard.manager").get("toolPreset", "read-only"),
    disallowedTools: workspace.getConfiguration("aboard.manager").get("disallowedTools", []),
  });
  const warnKey = "aboard.manager.permissionWarning";
  const launch = async (mode: "start" | "resume" | "new") => {
    const workerMode = workspace.getConfiguration("aboard.workers").get<WorkerPermissionMode>("permissionMode", "default");
    if (workerMode !== "bypass" && !context.globalState.get(warnKey)) { await window.showWarningMessage("Unattended workers may stall on permission prompts. For afk work, use the bypass permission mode."); await context.globalState.update(warnKey, true); }
    try {
      if (mode === "start" && await managerStore.load() !== undefined) {
        const choice = await window.showInformationMessage("A Manager session is already recorded. Resume it?", "Resume Manager", "New Manager");
        if (choice === undefined) return;
        mode = choice === "Resume Manager" ? "resume" : "new";
      }
      await manager.start(mode);
    } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to launch Manager"); }
  };
  context.subscriptions.push(
    commands.registerCommand("aboard.scaffoldProject", async () => {
      try {
        const autoCompactEnabled = workspace.getConfiguration("claudeCode").get<boolean>("autoCompact");
        const report = await scaffoldProject({
          projectRoot: workspaceRoot,
          assetRoot: join(context.extensionPath, "assets", "scaffold"),
          ...(autoCompactEnabled === undefined ? {} : { autoCompactEnabled }),
          todo: {
            ensure: async () => {
              try { await github.getTodo(); return "existing"; }
              catch (error) {
                if (!(error instanceof GitHubBoundaryError) || error.code !== "missing-todo") throw error;
                await github.updateTodo("# Project TODO\n\n- Add the next project priorities here."); return "created";
              }
            },
          },
        });
        for (const warning of report.warnings) { output.appendLine(`Warning: ${warning}`); void window.showWarningMessage(warning); }
        void window.showInformationMessage(`aboard project assets installed (${report.created.length} created, ${report.updated.length} updated, ${report.preserved.length} preserved).`);
      } catch (error) { void window.showErrorMessage(error instanceof Error ? error.message : "Unable to scaffold aboard project assets"); }
    }),
    commands.registerCommand("aboard.startManager", () => launch("start")),
    commands.registerCommand("aboard.resumeManager", () => launch("resume")),
    commands.registerCommand("aboard.newManager", () => launch("new")),
  );
  context.subscriptions.push({ dispose: () => void bridge?.stop() });
}

export async function deactivate(): Promise<void> {
  await bridge?.stop();
  bridge = undefined;
}
