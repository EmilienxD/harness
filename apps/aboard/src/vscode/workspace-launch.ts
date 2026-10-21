import { ProgressLocation, Uri, commands, window } from "vscode";
import { AgentWorkspaceFiles } from "../runtime/agent-workspace-owner.js";
import { WorkspaceStartup } from "../runtime/workspace-startup.js";
import { presentWorkspaceBatchResult, validateWorkspaceLaunchPlan } from "../platform/workspace-launcher.js";
import type { LauncherRequest } from "./launch-panel.js";

/** Each request creates a new window; existing windows are never launch targets. */
export class NewWorkspaceLauncher {
  #busy = false;
  constructor(private readonly options: {
    projectRoot: string;
    storageRoot: string;
    providers: readonly string[];
    files: AgentWorkspaceFiles;
    log: (message: string) => void;
  }) {}

  async launch(request: Pick<LauncherRequest, "preset">, projectRoot: string = this.options.projectRoot): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await window.withProgress({ location: ProgressLocation.Window, title: "Launching agent workspace", cancellable: false }, async (progress) => {
        const plan = validateWorkspaceLaunchPlan({ preset: request.preset, empty: false, manual: true }, this.options.providers);
        progress.report({ message: "Opening the new workspace…" });
        const handoff = await this.options.files.create(projectRoot, plan);
        const startup = new WorkspaceStartup(this.options.storageRoot, handoff);
        try { await commands.executeCommand("vscode.openFolder", Uri.file(handoff.workspaceFile), { forceNewWindow: true, noRecentEntry: true }); }
        catch (error) {
          // Reserve an unopened request so a delayed activation cannot replay it.
          await startup.wait({ activationTimeoutMs: 0 }).catch(() => undefined);
          throw error;
        }
        progress.report({ message: "Starting terminals in the new window…" });
        const result = await startup.wait();
        for (const failure of result.failed) this.options.log(`Workspace launch ${handoff.requestId}: ${failure.provider}: ${failure.message}`);
        await presentWorkspaceBatchResult(result, async (message) => { throw new Error(message); });
      });
    } catch (error) {
      this.options.log(`Workspace launch: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally { this.#busy = false; }
  }
}
