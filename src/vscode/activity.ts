
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
    // Run rows represent a whole frozen plan. Issue navigation belongs on the
    // agent row that carried one concrete issue.
    if (canOpenActivityIssue(entry)) capabilities.push("issue");
    if (entry.pullRequest !== undefined) capabilities.push("pr");
    if (entry.kind === "agent" && entry.reopen !== undefined && !live) capabilities.push("reopen");
    return {
      label: describeActivity(entry),
      description: describeDetail(entry),
      tooltip: tooltip(entry),
      icon: icon(entry),
      contextValue: capabilities.join("."),
      ...(live
        ? { command: { command: "aboard.activity.openTerminal", title: "Open Terminal", arguments: [node] } }
        : entry.kind === "agent" && entry.reopen !== undefined
          ? { command: { command: "aboard.activity.reopen", title: "Reopen Session", arguments: [node] } }
          : {}),
    };
  }
}

export function canOpenActivityIssue(entry: ActivityEntry): entry is ActivityEntry & { readonly issueNumbers: readonly [number] } {
  return entry.kind === "agent"
    && ["implementer", "pr-doctor-afk", "pr-doctor-hitl"].includes(entry.type)
    && entry.issueNumbers?.length === 1;
}

function describeDetail(entry: ActivityEntry): string {
  const parts = entry.kind === "agent" ? [
    entry.description,
    entry.issueNumbers === undefined || entry.issueNumbers.length === 0 ? "" : formatIssueNumbers(entry.issueNumbers),
    entry.pullRequest === undefined ? "" : `PR #${entry.pullRequest}`,
    formatDuration(entry.durationMs),
  ] : [
    `attempt ${entry.attempt}`,
    entry.completedIssues === undefined || entry.totalIssues === undefined ? "" : `${entry.completedIssues}/${entry.totalIssues} issues`,
    entry.currentIssue === undefined ? "" : `at #${entry.currentIssue}`,
    entry.pullRequest === undefined ? "" : `PR #${entry.pullRequest}`,
    formatDuration(entry.durationMs),
  ];
  return parts.filter(Boolean).join(" · ");
}

function tooltip(entry: ActivityEntry): string {
  return [
    describeActivity(entry),
    describeDetail(entry),
    entry.kind === "run" && (entry.issueNumbers?.length ?? 0) > 0
      ? `Planned issues: ${formatIssueNumbers(entry.issueNumbers ?? [])}`
      : "",
    entry.kind === "agent" ? `Agent ${entry.agentId} (${entry.type})` : `Run ${entry.runId}, attempt ${entry.attempt}`,
    `At ${new Date(entry.at).toLocaleString()} (${entry.at})`,
    entry.reason === undefined ? "" : entry.reason,
    entry.kind === "agent" && entry.reopen !== undefined ? "This conversation can be reopened." : "",
  ].filter(Boolean).join("\n");
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  if (durationMs < 60_000) return `${Math.max(1, Math.round(durationMs / 1_000))}s`;
  if (durationMs < 3_600_000) return `${Math.round(durationMs / 60_000)}m`;
  const hours = Math.floor(durationMs / 3_600_000);
  const minutes = Math.round((durationMs % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function icon(entry: ActivityEntry): string {
  if (entry.kind === "run") {
    switch (entry.outcome) {
      case "succeeded": return "pass";
      case "failed": return "error";
      case "cancelled": return "circle-slash";
      case "interrupted": return "debug-pause";
      case "discarded": return "trash";
      default: return "robot";
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
