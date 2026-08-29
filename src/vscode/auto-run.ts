/**
 * The Auto Run view's model.
 *
 * Pure and VS Code free, like the fleet model beside it. Its whole job is to
 * turn "what does the record say, and may it continue?" into one card with the
 * right actions on it — which is the surface that replaces the activation-time
 * Resume/Discard notification. A notification is a moment; recovery has to be a
 * place the user can go back to.
 */

import {
  completedCount,
  isUnsupportedRecord,
  issueProgress,
  type AutoRunRecord,
  type FrozenIssue,
  type IssueProgress,
  type PersistedAutoRunRecord,
  type RecoveryEligibility,
} from "../domain/run-plan.js";
import type { AutoRunState } from "../auto/engine.js";
import { currentPhase } from "../auto/engine.js";
import type { AutoRunDryRunResult, PlannedIssue } from "../domain/auto-run.js";

export type AutoRunPreview = Extract<AutoRunDryRunResult, { readonly inspected: true }>;

export type AutoRunCard =
  /** No record at all: the only thing to offer is a new run. */
  | { readonly kind: "idle" }
  /** Start was clicked and the engine is still discovering the GitHub queue. */
  | { readonly kind: "starting" }
  /** Preview was clicked and the read-only plan is still being discovered. */
  | { readonly kind: "previewing" }
  | { readonly kind: "preview"; readonly preview: AutoRunPreview }
  | { readonly kind: "active"; readonly state: AutoRunState; readonly record: AutoRunRecord }
  | { readonly kind: "waiting"; readonly state: AutoRunState; readonly record: AutoRunRecord }
  /** A record exists and its eligibility is still being computed. */
  | { readonly kind: "checking"; readonly record: AutoRunRecord }
  | { readonly kind: "recoverable"; readonly record: AutoRunRecord }
  | { readonly kind: "broken"; readonly record: AutoRunRecord; readonly reason: string }
  /** A version-1 record: nothing to continue, only something to forget. */
  | { readonly kind: "unsupported"; readonly reason: string };

export type AutoRunNode =
  | { readonly kind: "card"; readonly card: AutoRunCard }
  | { readonly kind: "issue"; readonly issue: FrozenIssue; readonly progress: IssueProgress; readonly title: string }
  | { readonly kind: "preview-issue"; readonly issue: PlannedIssue; readonly position: number; readonly total: number };

export interface AutoRunTreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly contextValue: string;
  readonly collapsible: boolean;
  readonly command?: { readonly command: string; readonly title: string; readonly arguments: readonly unknown[] };
}

export interface AutoRunViewSources {
  readonly starting: () => boolean;
  readonly previewing: () => boolean;
  readonly preview: () => AutoRunPreview | undefined;
  readonly state: () => AutoRunState | undefined;
  readonly persisted: () => PersistedAutoRunRecord | undefined;
  readonly eligibility: () => RecoveryEligibility | undefined;
  /** Live issue titles, for display only; the plan's frozen titles do the work. */
  readonly titles: () => Readonly<Record<string, string>>;
}

/**
 * Resolves the one card the view renders.
 *
 * The order matters: a live run outranks any recovery question about its own
 * record, and an unresolved record outranks the Start actions — offering Start
 * beside an unfinished run is how a user ends up with two runs competing for
 * the same branches.
 */
export function autoRunCard(sources: AutoRunViewSources): AutoRunCard {
  const persisted = sources.persisted();
  const state = sources.state();
  if (persisted !== undefined && isUnsupportedRecord(persisted)) {
    return { kind: "unsupported", reason: "run predates fixed-plan recovery" };
  }
  if (state !== undefined && persisted !== undefined) {
    return { kind: state.waiting ? "waiting" : "active", state, record: persisted };
  }
  if (sources.starting()) return { kind: "starting" };
  if (persisted === undefined) {
    if (sources.previewing()) return { kind: "previewing" };
    const preview = sources.preview();
    return preview === undefined ? { kind: "idle" } : { kind: "preview", preview };
  }
  const eligibility = sources.eligibility();
  if (eligibility === undefined || eligibility.state === "checking") return { kind: "checking", record: persisted };
  if (eligibility.state === "broken") return { kind: "broken", record: persisted, reason: eligibility.reason };
  return { kind: "recoverable", record: persisted };
}

/** The record behind the card, when there is one. */
export function cardRecord(card: AutoRunCard): AutoRunRecord | undefined {
  return card.kind === "idle" || card.kind === "starting" || card.kind === "previewing" || card.kind === "preview" || card.kind === "unsupported"
    ? undefined
    : card.record;
}

export class AutoRunTreeModel {
  public constructor(private readonly sources: AutoRunViewSources) {}

  public roots(): readonly AutoRunNode[] {
    return [{ kind: "card", card: autoRunCard(this.sources) }];
  }

  /** The frozen plan, in its immutable order. Never re-sorted by progress. */
  public children(node: AutoRunNode): readonly AutoRunNode[] {
    if (node.kind !== "card") return [];
    if (node.card.kind === "preview") {
      const issues = node.card.preview.issues;
      return issues.map((issue, index): AutoRunNode => ({
        kind: "preview-issue",
        issue,
        position: index + 1,
        total: issues.length,
      }));
    }
    const record = cardRecord(node.card);
    if (record === undefined) return [];
    const titles = this.sources.titles();
    return record.plan.map((issue): AutoRunNode => ({
      kind: "issue",
      issue,
      progress: issueProgress(record, issue.number),
      title: titles[String(issue.number)] ?? issue.title,
    }));
  }

  public item(node: AutoRunNode): AutoRunTreeItem {
    if (node.kind === "card") return cardItem(node.card);
    return node.kind === "issue" ? issueItem(node) : previewIssueItem(node);
  }
}

function cardItem(card: AutoRunCard): AutoRunTreeItem {
  switch (card.kind) {
    case "idle":
      return {
        label: "Run auto mode",
        description: "",
        tooltip: "Start an auto-run to work the labelled issue queue one issue at a time.",
        icon: "play-circle",
        contextValue: "aboard.autoRun.idle",
        collapsible: false,
      };
    case "starting":
      return {
        label: "Starting auto-run",
        description: "loading issues from GitHub…",
        tooltip: "aboard is loading and ordering the GitHub issues this run will process.",
        icon: "loading~spin",
        contextValue: "aboard.autoRun.starting",
        collapsible: false,
      };
    case "previewing":
      return {
        label: "Previewing auto-run",
        description: "loading issues from GitHub…",
        tooltip: "aboard is loading and ordering the GitHub issues without starting a run.",
        icon: "loading~spin",
        contextValue: "aboard.autoRun.previewing",
        collapsible: false,
      };
    case "preview": {
      const { preview } = card;
      const count = preview.issues.length;
      return {
        label: "Auto-run preview",
        description: preview.ready
          ? `${count} issue${count === 1 ? "" : "s"} queued`
          : `cannot start · ${preview.blockers.length} blocker${preview.blockers.length === 1 ? "" : "s"}`,
        tooltip: previewTooltip(preview),
        icon: preview.ready ? "list-tree" : "warning",
        contextValue: "aboard.autoRun.preview",
        collapsible: count > 0,
      };
    }
    case "active": {
      const { state, record } = card;
      return {
        label: `Auto-run ${record.runId}`,
        description: `${state.phase} · issue #${state.currentIssue ?? "?"} · ${state.completedCount}/${state.totalCount}`,
        tooltip: runTooltip(record, state),
        icon: "sync~spin",
        contextValue: "aboard.autoRun.active",
        collapsible: true,
      };
    }
    case "waiting": {
      const { state, record } = card;
      return {
        label: `Auto-run ${record.runId}`,
        description: `waiting for you · issue #${state.currentIssue ?? "?"}`,
        tooltip: `${runTooltip(record, state)}\n\nMerge the pull request, or approve it from another account, and the run continues.`,
        icon: "person",
        contextValue: "aboard.autoRun.waiting",
        collapsible: true,
      };
    }
    case "checking":
      return {
        label: `Auto-run ${card.record.runId}`,
        description: "checking whether it can be resumed…",
        tooltip: "aboard is comparing the recorded run against git and GitHub. Resume becomes available only if they still agree.",
        icon: "loading~spin",
        contextValue: "aboard.autoRun.checking",
        collapsible: true,
      };
    case "recoverable":
      return {
        label: `Auto-run ${card.record.runId}`,
        description: `${describeOutcome(card.record)} · ${completedCount(card.record)}/${card.record.plan.length} done`,
        tooltip: `${runTooltip(card.record)}\n\nResume continues at the first unfinished step, using the settings this run started with.`,
        icon: "debug-continue",
        contextValue: "aboard.autoRun.recoverable",
        collapsible: true,
      };
    case "broken":
      return {
        label: `Auto-run ${card.record.runId}`,
        description: `cannot be resumed — ${card.reason}`,
        tooltip: `${runTooltip(card.record)}\n\nThis run cannot continue: ${card.reason}. Nothing has been rolled back; discarding forgets the record.`,
        icon: "error",
        contextValue: "aboard.autoRun.broken",
        collapsible: true,
      };
    case "unsupported":
      return {
        label: "Interrupted auto-run",
        description: `cannot be resumed — ${card.reason}`,
        tooltip: "This record was written before fixed-plan recovery and carries no plan to validate. Its branches and pull requests are untouched; discard the record when you have finished with them.",
        icon: "error",
        contextValue: "aboard.autoRun.unsupported",
        collapsible: false,
      };
  }
}

function issueItem(node: Extract<AutoRunNode, { kind: "issue" }>): AutoRunTreeItem {
  const { issue, progress, title } = node;
  const state = progress.state === "done"
    ? progress.result === "landed" ? `done · PR #${progress.prNumber}` : "done · no changes needed"
    : progress.state === "current" ? `current · ${progress.phase}` : "pending";
  return {
    label: `#${issue.number} ${title}`,
    description: state,
    tooltip: [
      `Issue #${issue.number}`,
      `Disposition: ${issue.disposition}`,
      issue.difficulty === undefined ? "Difficulty: unrated" : `Difficulty: ${issue.difficulty}`,
      issue.chrome === true ? "Claude in Chrome: enabled by [AI]-chrome" : "",
      `Branch: ${issue.branch}`,
      issue.dependsOn.length === 0 ? "" : `Depends on ${issue.dependsOn.map((number) => `#${number}`).join(", ")}`,
    ].filter(Boolean).join("\n"),
    icon: progress.state === "done" ? "pass" : progress.state === "current" ? "circle-filled" : "circle-outline",
    contextValue: `aboard.autoRun.issue.${progress.state}`,
    collapsible: false,
    command: { command: "aboard.openIssue", title: "Open Issue", arguments: [issue.number] },
  };
}

function previewIssueItem(node: Extract<AutoRunNode, { kind: "preview-issue" }>): AutoRunTreeItem {
  const { issue, position, total } = node;
  return {
    label: `#${issue.number} ${issue.title}`,
    description: `${position}/${total} · ${issue.disposition}`,
    tooltip: [
      `Issue #${issue.number}`,
      `Execution order: ${position} of ${total}`,
      `Disposition: ${issue.disposition}`,
      issue.difficulty === undefined ? "Difficulty: unrated" : `Difficulty: ${issue.difficulty}`,
      issue.chrome === true ? "Claude in Chrome: enabled by [AI]-chrome" : "",
      `Planned branch: ${issue.branch}`,
    ].filter(Boolean).join("\n"),
    icon: "issue-opened",
    contextValue: "aboard.autoRun.previewIssue",
    collapsible: false,
    command: { command: "aboard.openIssue", title: "Open Issue", arguments: [issue.number] },
  };
}

function previewTooltip(preview: AutoRunPreview): string {
  return [
    "Read-only snapshot; Preview again to refresh it before starting.",
    `Target branch: ${preview.sessionBase}`,
    preview.isolatedWorkspace ? "Would work in a separate checkout" : "Would work in your checkout",
    `Review ${preview.reviewMode ? "on" : "off"}`,
    preview.ready ? "Ready to start" : `Cannot start: ${preview.blockers.join("; ")}`,
    preview.skipped.length === 0
      ? ""
      : `Skipped: ${preview.skipped.map((issue) => `#${issue.number} (${issue.reason})`).join("; ")}`,
  ].filter(Boolean).join("\n");
}

function describeOutcome(record: AutoRunRecord): string {
  const outcome = record.outcome;
  if (outcome === undefined) return "interrupted";
  switch (outcome.kind) {
    case "cancelled": return "stopped by you";
    case "interrupted": return "interrupted";
    case "failed": return `failed — ${outcome.reason}`;
  }
}

function runTooltip(record: AutoRunRecord, state?: AutoRunState): string {
  return [
    `Run ${record.runId} (attempt ${record.attempt})`,
    `Session branch: ${record.sessionBranch}`,
    `Target branch: ${record.targetBranch ?? "the repository default"}`,
    record.settings.workspaceRoot === undefined ? "Working in your checkout" : `Working in ${record.settings.workspaceRoot}`,
    `Review ${record.settings.review ? "on" : "off"}`,
    record.runPullRequest === undefined ? "" : `Run pull request: #${record.runPullRequest}`,
    state?.currentPullRequest === undefined ? "" : `Current pull request: #${state.currentPullRequest}`,
  ].filter(Boolean).join("\n");
}

/** The pull request a card's actions should open, when there is one. */
export function cardPullRequest(card: AutoRunCard, state: AutoRunState | undefined): number | undefined {
  return state?.currentPullRequest ?? cardRecord(card)?.runPullRequest;
}
