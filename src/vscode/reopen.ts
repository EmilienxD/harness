import type { Disposable } from "vscode";

import { describeReopenOutcome, type ReopenCoordinator, type ReopenOption } from "../claude/reopen.js";
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

/**
 * One row per recorded session. The label is the name the session runs under —
 * `aboard-<type>-<id>`, the `--agent` argument and the `@<name>` banner the
 * terminal prints — so the picker, the fleet tree, and the TUI head all name the
 * same conversation identically, and a row is greppable straight back to its
 * definition file.
 */
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
    // Named plainly rather than hidden: Claude Code sweeps its own transcripts
    // after `cleanupPeriodDays`, and a row that vanished without saying so would
    // read as aboard losing the session.
    return `Cannot be reopened — Claude Code no longer has this conversation (ended ${age(candidate.at, now)})${chrome}`;
  }
  switch (candidate.origin) {
    case "live": return `Running now — opens its terminal${chrome}`;
    case "paused": return `Paused after VS Code restarted · started ${age(candidate.at, now)}${chrome}`;
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

/**
 * `aboard.reopenSession`. The command asks rather than guesses: unlike
 * `review_pr`, which has exactly one pull request in flight to reopen, there is
 * no single obvious conversation to return to, and reopening the wrong one costs
 * a terminal and the user's attention.
 */
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
      host.info("aboard has no recorded sessions to reopen yet. Sessions you are handed — brainstormer, general-purpose, pr-doctor-hitl — appear here after they end.");
      return;
    }
    const chosen = await host.pick(items, "Reopen an aboard session");
    if (chosen === undefined) return;
    if (!chosen.option.resumable) {
      host.warning(`Claude Code no longer has the conversation for ${chosen.label}. It deletes session files older than its cleanupPeriodDays setting, and aboard backs up only the Manager's transcript.`);
      return;
    }
    try {
      host.info(describeReopenOutcome(await reopen.reopen(chosen.option.candidate)));
    } catch (error) {
      host.error(error instanceof Error ? error.message : "Unable to reopen that session");
    }
  });
}
