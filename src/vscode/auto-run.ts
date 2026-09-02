
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
import type { AutoRunDryRunResult, PlannedIssue, SkippedIssue } from "../domain/auto-run.js";
import { formatTimestamp } from "../shared/time.js";

export type AutoRunPreview = Extract<AutoRunDryRunResult, { readonly inspected: true }>;

export interface AutoRunForecast {
  readonly preview: AutoRunPreview | undefined;
  readonly checking: boolean;
  readonly stale: boolean;
  readonly checkedAt: string | undefined;
  readonly error: string | undefined;
}

export class AutoRunForecastController {
  #value: AutoRunForecast = { preview: undefined, checking: false, stale: false, checkedAt: undefined, error: undefined };
  #generation = 0;
  #inFlight: Promise<void> | undefined;

  public constructor(
    private readonly onDidChange: () => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public snapshot(): AutoRunForecast {
    return this.#value;
  }

  public invalidate(): void {
    this.#generation += 1;
    this.#inFlight = undefined;
    this.#value = { preview: undefined, checking: false, stale: false, checkedAt: undefined, error: undefined };
  }

  public markStale(): void {
    this.#generation += 1;
    this.#inFlight = undefined;
    this.#value = { ...this.#value, checking: false, stale: this.#value.preview !== undefined, error: undefined };
    this.onDidChange();
  }

  public replace(preview: AutoRunPreview): void {
    this.#generation += 1;
    this.#inFlight = undefined;
    this.#value = { preview, checking: false, stale: false, checkedAt: this.now().toISOString(), error: undefined };
    this.onDidChange();
  }

  public fail(error: string): void {
    this.#generation += 1;
    this.#inFlight = undefined;
    this.#value = { ...this.#value, checking: false, error };
    this.onDidChange();
  }

  public refresh(inspect: () => Promise<AutoRunDryRunResult>): Promise<void> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const generation = ++this.#generation;
    this.#value = { ...this.#value, checking: true, error: undefined };
    this.onDidChange();
    const check = (async () => {
      try {
        const result = await inspect();
        if (generation !== this.#generation) return;
        this.#value = result.inspected
          ? { preview: result, checking: false, stale: false, checkedAt: this.now().toISOString(), error: undefined }
          : { ...this.#value, checking: false, error: result.reason };
      } catch (error) {
        if (generation !== this.#generation) return;
        this.#value = {
          ...this.#value,
          checking: false,
          error: error instanceof Error ? error.message : "Unable to inspect the next auto-run",
        };
      } finally {
        if (generation === this.#generation) this.onDidChange();
      }
    })();
    this.#inFlight = check;
    void check.finally(() => { if (this.#inFlight === check) this.#inFlight = undefined; });
    return check;
  }
}

export type AutoRunCard =
  /** No record at all: the only thing to offer is a new run. */
  | { readonly kind: "idle" }
  /** Start was clicked and the engine is still discovering the GitHub queue. */
  | { readonly kind: "starting" }
  /** The view is discovering the next run for the first time. */
  | { readonly kind: "checking-next" }
  | { readonly kind: "forecast"; readonly forecast: AutoRunForecast & { readonly preview: AutoRunPreview } }
  | { readonly kind: "unavailable"; readonly error: string }
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
  | { readonly kind: "issue"; readonly issue: FrozenIssue; readonly progress: IssueProgress; readonly title: string; readonly implementerLive: boolean; readonly workingBranch: string }
  | { readonly kind: "forecast-issue"; readonly issue: PlannedIssue; readonly position: number; readonly total: number; readonly branchMode: "per-issue" | "single-branch" };

export interface AutoRunTreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon?: string;
  readonly contextValue: string;
  readonly collapsible: boolean;
  readonly command?: { readonly command: string; readonly title: string; readonly arguments: readonly unknown[] };
}

export interface AutoRunViewSources {
  readonly starting: () => boolean;
  readonly forecast: () => AutoRunForecast;
  readonly state: () => AutoRunState | undefined;
  readonly persisted: () => PersistedAutoRunRecord | undefined;
  readonly eligibility: () => RecoveryEligibility | undefined;
  /** Live issue titles, for display only; the plan's frozen titles do the work. */
  readonly titles: () => Readonly<Record<string, string>>;
  /** Whether a live implementer session exists for this issue number. */
  readonly hasLiveImplementer?: (issueNumber: number) => boolean;
}

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
    const forecast = sources.forecast();
    if (forecast.preview !== undefined) return { kind: "forecast", forecast: { ...forecast, preview: forecast.preview } };
    if (forecast.checking) return { kind: "checking-next" };
    if (forecast.error !== undefined) return { kind: "unavailable", error: forecast.error };
    return { kind: "idle" };
  }
  const eligibility = sources.eligibility();
  if (eligibility === undefined || eligibility.state === "checking") return { kind: "checking", record: persisted };
  if (eligibility.state === "broken") return { kind: "broken", record: persisted, reason: eligibility.reason };
  return { kind: "recoverable", record: persisted };
}

/**
 * The card's menu identity: the `aboard.autoRunCard` context key and the card
 * row's contextValue suffix. A forecast with blockers is its own state so the
 * `when` clauses that offer Start on an exact `forecast` match hide it, rather
 * than inviting a click that can only fail.
 */
export function autoRunCardMenuState(card: AutoRunCard): string {
  if (card.kind !== "forecast") return card.kind;
  if (card.forecast.checking) return "forecastChecking";
  if (card.forecast.stale || card.forecast.error !== undefined) return "forecastStale";
  const preview = card.forecast.preview;
  // An empty queue is not a problem to fix, so it keeps a neutral identity
  // distinct from a forecast that is genuinely blocked. Both hide Start.
  if (preview.emptyReason !== undefined && preview.blockers.length === 0) return "forecastEmpty";
  return preview.ready ? card.kind : "forecastBlocked";
}

/** The record behind the card, when there is one. */
export function cardRecord(card: AutoRunCard): AutoRunRecord | undefined {
  return card.kind === "idle" || card.kind === "starting" || card.kind === "checking-next" || card.kind === "forecast" || card.kind === "unavailable" || card.kind === "unsupported"
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
    if (node.card.kind === "forecast") {
      const issues = node.card.forecast.preview.issues;
      const branchMode = node.card.forecast.preview.branchMode ?? "per-issue";
      return issues.map((issue, index): AutoRunNode => ({
        kind: "forecast-issue",
        issue,
        position: index + 1,
        total: issues.length,
        branchMode,
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
      implementerLive: this.sources.hasLiveImplementer?.(issue.number) ?? false,
      workingBranch: record.settings.branchMode === "single-branch" ? record.sessionBranch : issue.branch,
    }));
  }

  public item(node: AutoRunNode): AutoRunTreeItem {
    if (node.kind === "card") return cardItem(node.card);
    return node.kind === "issue" ? issueItem(node) : forecastIssueItem(node);
  }
}

// The card reports state; its actions belong exclusively in the inline menu.
function cardItem(card: AutoRunCard): AutoRunTreeItem & { readonly command?: never } {
  switch (card.kind) {
    case "idle":
      return {
        label: "Next auto-run",
        description: "not checked yet",
        tooltip: "Open this view or use Check Now to load the issues the next auto-run would process.",
        icon: "tasklist",
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
    case "checking-next":
      return {
        label: "Checking next auto-run",
        description: "loading issues from GitHub…",
        tooltip: "aboard is loading and ordering the GitHub issues the next run would process.",
        icon: "loading~spin",
        contextValue: "aboard.autoRun.checkingNext",
        collapsible: false,
      };
    case "forecast": {
      const { preview } = card.forecast;
      const count = preview.issues.length;
      const empty = preview.emptyReason !== undefined && preview.blockers.length === 0;
      return {
        label: "Next auto-run",
        description: card.forecast.checking
          ? `${count} issue${count === 1 ? "" : "s"} queued · refreshing…`
          : card.forecast.stale
            ? `${count} issue${count === 1 ? "" : "s"} queued · update needed`
            : empty
              ? "nothing to run"
              : preview.ready
                ? `${count} issue${count === 1 ? "" : "s"} queued${preview.warnings.length === 0 ? "" : " · warning"}`
                : `cannot start · ${preview.blockers.length} blocker${preview.blockers.length === 1 ? "" : "s"}`,
        tooltip: forecastTooltip(card.forecast),
        icon: card.forecast.checking ? "loading~spin" : preview.warnings.length > 0 || (!empty && !preview.ready) ? "warning" : "tasklist",
        contextValue: `aboard.autoRun.${autoRunCardMenuState(card)}`,
        collapsible: count > 0,
      };
    }
    case "unavailable":
      return {
        label: "Next auto-run",
        description: "check failed",
        tooltip: `aboard could not inspect the next auto-run: ${card.error}. Use Check Now to try again.`,
        icon: "warning",
        contextValue: "aboard.autoRun.forecastUnavailable",
        collapsible: false,
      };
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
        icon: card.record.outcome?.kind === "failed" ? "error" : card.record.outcome?.kind === "cancelled" ? "circle-slash" : "warning",
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
  const { issue, progress, title, implementerLive } = node;
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
      `Branch: ${node.workingBranch}`,
      issue.dependsOn.length === 0 ? "" : `Depends on ${issue.dependsOn.map((number) => `#${number}`).join(", ")}`,
    ].filter(Boolean).join("\n"),
    // Row clicks are terminal-only. Pending issues therefore do nothing, while
    // the issue-icon button remains the single way to open GitHub from a row.
    contextValue: implementerLive
      ? `aboard.autoRun.issue.${progress.state}.implementer`
      : `aboard.autoRun.issue.${progress.state}`,
    collapsible: false,
    command: { command: "aboard.autoRun.focusImplementer", title: "Focus Implementer", arguments: [issue.number] },
  };
}

function forecastIssueItem(node: Extract<AutoRunNode, { kind: "forecast-issue" }>): AutoRunTreeItem {
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
      node.branchMode === "single-branch" ? "Planned branch: run session branch" : `Planned branch: ${issue.branch}`,
    ].filter(Boolean).join("\n"),
    contextValue: "aboard.autoRun.issue.forecast",
    collapsible: false,
    command: { command: "aboard.autoRun.focusImplementer", title: "Focus Implementer", arguments: [issue.number] },
  };
}

function forecastTooltip(forecast: AutoRunForecast & { readonly preview: AutoRunPreview }): string {
  const { preview } = forecast;
  return [
    forecast.checkedAt === undefined ? "" : `Updated at: ${formatTimestamp(forecast.checkedAt)}`,
    "Start checks once more and runs only if the plan is unchanged.",
    forecast.stale ? "Settings changed. Use Check Now to update this preview." : "",
    forecast.error === undefined ? "" : `Last refresh failed: ${forecast.error}. The list below is the last successful result.`,
    `Target branch: ${preview.sessionBase}`,
    `Branch mode: ${preview.branchMode ?? "per-issue"}`,
    preview.branchMode === "single-branch" ? "All issues are committed to the session branch; one cumulative pull request is used." : "Each issue uses its own branch and pull request.",
    ...preview.warnings.map((warning) => `Warning: ${warning}`),
    preview.isolatedWorkspace ? "Would work in a separate checkout" : "Would work in your checkout",
    `Review ${preview.reviewMode ? "on" : "off"}`,
    preview.permanentPrompt === undefined ? "" : "Configured auto-run note will be included",
    preview.additionalGuideline === undefined ? "" : "Per-run auto note will be included after the configured note",
    preview.emptyReason !== undefined && preview.blockers.length === 0
      ? `Nothing to run: ${preview.emptyReason}`
      : preview.ready
        ? "Ready to start"
        : `Cannot start: ${preview.blockers.join("; ")}`,
    ...skippedLines(preview.skipped),
  ].filter(Boolean).join("\n");
}

/**
 * Summarizes the skipped list for the forecast tooltip. Unclassified issues are
 * the ordinary state of most projects and can number in the dozens, so they get
 * a count; the actionable "blocked by" entries keep their per-issue reasons.
 */
function skippedLines(skipped: readonly SkippedIssue[]): string[] {
  const unclassified = skipped.filter((issue) => issue.reason.startsWith("unclassified:"));
  const other = skipped.filter((issue) => !issue.reason.startsWith("unclassified:"));
  const lines: string[] = [];
  if (unclassified.length > 0) {
    lines.push(`${unclassified.length} unclassified issue${unclassified.length === 1 ? "" : "s"} skipped (neither [AI]-afk nor [AI]-hitl)`);
  }
  if (other.length > 0) {
    lines.push(`Skipped: ${other.map((issue) => `#${issue.number} (${issue.reason})`).join("; ")}`);
  }
  return lines;
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
    `Branch mode: ${record.settings.branchMode ?? "per-issue"}`,
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
