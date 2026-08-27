/**
 * The Recent Activity view's model.
 *
 * Pure and VS Code free. It renders what aboard's agents and runs did, newest
 * first, with the actions each row can actually offer — a terminal that is still
 * open, an issue, a pull request, a conversation that can be reopened. Detailed
 * errors stay in the output channel; a history row says what happened, not how.
 */

import { describeActivity, type ActivityDto, type ActivityEntry } from "../domain/activity.js";
import { formatIssueNumbers } from "../shared/issues.js";
import type { TerminalId } from "../domain/contracts.js";

export interface ActivityNode {
  readonly kind: "activity";
  readonly entry: ActivityEntry;
}

export interface ActivityTreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  /**
   * Dot-separated capability flags, so `view/item/context` can match on what a
   * row can do rather than on what kind of row it is.
   */
  readonly contextValue: string;
  readonly command?: { readonly command: string; readonly title: string; readonly arguments: readonly unknown[] };
}

export interface ActivityViewSources {
  readonly entries: () => readonly ActivityEntry[];
  /** Whether a recorded terminal is still open, so a dead one offers no action. */
  readonly isTerminalOpen: (terminalId: TerminalId) => boolean;
}

export class ActivityTreeModel {
  public constructor(private readonly sources: ActivityViewSources) {}

  public roots(): readonly ActivityNode[] {
    return this.sources.entries().map((entry) => ({ kind: "activity", entry }));
  }

  public item(node: ActivityNode): ActivityTreeItem {
    const { entry } = node;
    const capabilities = ["aboard.activity"];
    const live = entry.kind === "agent" && entry.terminalId !== undefined && this.sources.isTerminalOpen(entry.terminalId);
    if (live) capabilities.push("terminal");
    if ((entry.issueNumbers?.length ?? 0) > 0) capabilities.push("issue");
    if (entry.pullRequest !== undefined) capabilities.push("pr");
    if (entry.kind === "agent" && entry.reopen !== undefined && !live) capabilities.push("reopen");
    if (entry.kind === "agent" && entry.type === "manager" && !live) capabilities.push("manager");
    return {
      label: describeActivity(entry),
      description: describeDetail(entry),
      tooltip: tooltip(entry),
      icon: icon(entry),
      contextValue: capabilities.join("."),
      ...(live
        ? { command: { command: "aboard.activity.openTerminal", title: "Open Terminal", arguments: [node] } }
        : entry.kind === "agent" && entry.type === "manager"
          ? { command: { command: "aboard.resumeManager", title: "Resume Manager", arguments: [] } }
          : entry.kind === "agent" && entry.reopen !== undefined
          ? { command: { command: "aboard.activity.reopen", title: "Reopen Session", arguments: [node] } }
          : {}),
    };
  }
}

function describeDetail(entry: ActivityEntry): string {
  const parts = [
    entry.kind === "agent" ? entry.description : `attempt ${entry.attempt}`,
    entry.issueNumbers === undefined || entry.issueNumbers.length === 0 ? "" : formatIssueNumbers(entry.issueNumbers),
    entry.pullRequest === undefined ? "" : `PR #${entry.pullRequest}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

function tooltip(entry: ActivityEntry): string {
  return [
    describeActivity(entry),
    entry.kind === "agent" ? `Agent ${entry.agentId} (${entry.type})` : `Run ${entry.runId}, attempt ${entry.attempt}`,
    `At ${entry.at}`,
    entry.reason === undefined ? "" : entry.reason,
    entry.kind === "agent" && entry.reopen !== undefined ? "This conversation can be reopened." : "",
  ].filter(Boolean).join("\n");
}

function icon(entry: ActivityEntry): string {
  if (entry.kind === "run") {
    switch (entry.outcome) {
      case "succeeded": return "pass";
      case "failed": return "error";
      case "cancelled": return "circle-slash";
      case "interrupted": return "debug-pause";
      case "discarded": return "trash";
      default: return "rocket";
    }
  }
  switch (entry.outcome) {
    case "succeeded": return "pass";
    case "failed":
    case "launch-failed": return "error";
    case "cancelled": return "circle-slash";
    case "killed": return "close";
    case "interrupted": return "debug-pause";
    case "ended": return "comment-discussion";
  }
}

/** The modal warning shown before Clear All, when clearing costs the user something. */
export function clearActivityWarning(store: ActivityDto | undefined): string | undefined {
  const reopenable = (store?.entries ?? []).filter((entry) => entry.kind === "agent" && entry.reopen !== undefined).length;
  if (reopenable === 0) return undefined;
  return `Clearing recent activity also removes aboard's record of ${reopenable} conversation${reopenable === 1 ? "" : "s"} it could reopen for you. The Claude transcripts themselves stay on disk, but aboard will no longer know which agent they belonged to.`;
}
