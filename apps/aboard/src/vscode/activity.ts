
import { describeActivity, type ActivityDto, type ActivityEntry, type AgentOutcome } from "../domain/activity.js";
import { formatIssueNumbers } from "../shared/issues.js";
import { formatTimestamp } from "../shared/time.js";
import { agentLabel, type TerminalId } from "../domain/contracts.js";

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
      // The side panel is narrow, so lead with the conversation title when known.
      label: entry.kind === "agent" ? entry.title ?? agentLabel(entry) : describeActivity(entry),
      description: describeDetail(entry),
      tooltip: tooltip(entry),
      icon: icon(entry),
      contextValue: capabilities.join("."),
      // Clicking a row does nothing on its own; the inline icon buttons carry
      // the actions (focus the live terminal, reopen a dead conversation, ...).
    };
  }
}

export function canOpenActivityIssue(entry: ActivityEntry): entry is ActivityEntry & { readonly issueNumbers: readonly [number] } {
  return entry.kind === "agent"
    && ["address", "review"].includes(entry.type)
    && entry.issueNumbers?.length === 1;
}

function describeDetail(entry: ActivityEntry): string {
  const parts = entry.kind === "agent" ? [
    agentOutcome(entry.outcome),
    entry.title === undefined ? "" : agentLabel(entry),
    // Terminals are usually named after the agent; repeat only a description that adds something.
    entry.description === agentLabel(entry) ? "" : entry.description,
    entry.issueNumbers === undefined || entry.issueNumbers.length === 0 ? "" : formatIssueNumbers(entry.issueNumbers),
    entry.pullRequest === undefined ? "" : `PR #${entry.pullRequest}`,
    formatDuration(entry.durationMs),
  ] : [
    entry.attempt === 1 ? "" : `attempt ${entry.attempt}`,
    entry.completedIssues === undefined || entry.totalIssues === undefined ? "" : `${entry.completedIssues}/${entry.totalIssues} issues`,
    entry.currentIssue === undefined ? "" : `at #${entry.currentIssue}`,
    entry.pullRequest === undefined ? "" : `PR #${entry.pullRequest}`,
    formatDuration(entry.durationMs),
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The row's name already carries the agent type, so the outcome is one word or two. */
function agentOutcome(outcome: AgentOutcome): string {
  switch (outcome) {
    case "succeeded": return "finished";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "ended": return "ended";
    case "killed": return "terminal closed";
    case "launch-failed": return "could not start";
    case "interrupted": return "interrupted";
  }
}

function tooltip(entry: ActivityEntry): string {
  return [
    entry.kind === "agent" ? agentLabel(entry) : "",
    describeActivity(entry),
    describeDetail(entry),
    entry.kind === "run" && (entry.issueNumbers?.length ?? 0) > 0
      ? `Planned issues: ${formatIssueNumbers(entry.issueNumbers ?? [])}`
      : "",
    entry.kind === "run" ? `Run ${entry.runId}, attempt ${entry.attempt}` : "",
    `At ${formatTimestamp(entry.at)}`,
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
  // Pass or error only: the user should be able to scan the list and know at a
  // glance whether the row is a success log or a failure log.
  if (entry.kind === "run") {
    return entry.outcome === "succeeded" || entry.outcome === "started" ? "pass" : "error";
  }
  switch (entry.outcome) {
    case "succeeded":
    case "ended": return "pass";
    default: return "error";
  }
}

/** The modal warning shown before Clear All, when clearing costs the user something. */
export function clearActivityWarning(store: ActivityDto | undefined): string | undefined {
  const reopenable = (store?.entries ?? []).filter((entry) => entry.kind === "agent" && entry.reopen !== undefined).length;
  if (reopenable === 0) return undefined;
  return `Clearing recent activity also removes aboard's record of ${reopenable} conversation${reopenable === 1 ? "" : "s"} it could reopen for you. The platform's conversation data stays on disk, but aboard will no longer know which agent it belonged to.`;
}
