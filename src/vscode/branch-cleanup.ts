import type { Disposable } from "vscode";

import { describeAboardBranchDiscovery, type AboardBranchCleanup } from "../git/branch-cleanup.js";

export interface BranchCleanupCommandHost {
  registerCommand(command: string, callback: () => Promise<void>): Disposable;
  confirm(message: string, detail: string, action: string): Promise<string | undefined>;
  info(message: string): void;
  error(message: string): void;
}

export function registerBranchCleanupCommand(host: BranchCleanupCommandHost, cleanup: AboardBranchCleanup): Disposable {
  return host.registerCommand("aboard.clearBranches", async () => {
    try {
      const snapshot = await cleanup.discover();
      const detail = describeAboardBranchDiscovery(snapshot);
      if (snapshot.branches.length === 0) { host.info(detail); return; }
      const choice = await host.confirm("Clear all remaining aboard branches?", detail, "Clear");
      if (choice !== "Clear") return;
      const result = await cleanup.clear(snapshot);
      const removed = [...result.deletedLocal.map((branch) => `local ${branch}`), ...result.deletedRemote.map((branch) => `origin/${branch}`)];
      host.info(`Aboard branch cleanup finished${removed.length === 0 ? "" : `; removed ${removed.join(", ")}`}.${result.retained.length === 0 ? "" : ` Retained: ${result.retained.join("; ")}.`}`);
    } catch (error) {
      host.error(error instanceof Error ? error.message : "Unable to clear aboard branches");
    }
  });
}
