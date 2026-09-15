import type { Disposable } from "vscode";

import { describeReopenOutcome, type ReopenCoordinator, type ReopenOption } from "../platform/reopen.js";
import { describeIssueNumbers } from "../shared/issues.js";

export interface ReopenQuickPickItem {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly option: ReopenOption;
}

export interface ReopenCommandHost {
  registerCommand(command: string, callback: (...args: readonly unknown[]) => unknown): Disposable;
  /** Returns the chosen item, or undefined when the user dismissed the picker. */
  pick(items: readonly ReopenQuickPickItem[], placeholder: string): Promise<ReopenQuickPickItem | undefined>;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export function renderReopenItems(
  options: readonly ReopenOption[],
  now: Date = new Date(),
): readonly ReopenQuickPickItem[] {
  return options.map((option) => {
    const { candidate } = option;
    const described = candidate.issueNumbers === undefined ? "" : describeIssueNumbers(candidate.issueNumbers);
    const issues = described.length === 0 ? "" : ` · ${described}`;
    return {
      label: `aboard-${candidate.type}-${candidate.agentId}`,
      description: `${candidate.description}${issues}`,
      detail: detailFor(option, now),
      option,
    };
  });
}

function detailFor(option: ReopenOption, now: Date): string {
  const { candidate } = option;
  const chrome = candidate.chromeEnabled === true ? " · Chrome" : "";
  if (!option.resumable) {
    return option.reason === "inspection-failed"
      ? `Cannot inspect this conversation; ${option.diagnostic ?? "unknown platform error"}${chrome}`
      : `Cannot be reopened; the selected agent platform no longer has this conversation (ended ${age(candidate.at, now)})${chrome}`;
  }
  switch (candidate.origin) {
    case "live": return `Running now; opens its terminal${chrome}`;
    case "ended": return `Ended ${age(candidate.at, now)}${chrome}`;
  }
}

/** Coarse on purpose: the picker sorts by recency, so this only has to place a row in time. */
export function age(at: string, now: Date): string {
  const elapsed = now.getTime() - Date.parse(at);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "recently";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function registerReopenCommand(host: ReopenCommandHost, reopen: ReopenCoordinator): Disposable {
  return host.registerCommand("aboard.reopenSession", async () => {
    let items: readonly ReopenQuickPickItem[];
    try {
      items = renderReopenItems(await reopen.list());
    } catch (error) {
      host.error(error instanceof Error ? error.message : "Unable to list aboard sessions");
      return;
    }
    if (items.length === 0) {
      host.info("aboard has no recorded sessions to reopen yet.");
      return;
    }
    const chosen = await host.pick(items, "Reopen an aboard session");
    if (chosen === undefined) return;
    if (!chosen.option.resumable) {
      host.warning(chosen.option.reason === "inspection-failed"
        ? `The conversation for ${chosen.label} could not be inspected: ${chosen.option.diagnostic ?? "unknown platform error"}`
        : `The selected agent platform no longer has the conversation for ${chosen.label}, so it cannot be reopened.`);
      return;
    }
    try {
      const outcome = await reopen.reopen(chosen.option.candidate);
      if (outcome.action === "unresumable") host.warning(describeReopenOutcome(outcome));
      else if (outcome.action === "none") host.info(describeReopenOutcome(outcome));
    } catch (error) {
      host.error(error instanceof Error ? error.message : "Unable to reopen that session");
    }
  });
}
