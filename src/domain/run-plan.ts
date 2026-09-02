
import { LABEL_CHROME, hasLabel, issueDifficulty, issueDisposition, type IssueDifficulty } from "../shared/labels.js";
import {
  branchName,
  type AutoRunPhase,
  type CandidateIssue,
  type IssueDisposition,
  type MergeStrategy,
  type SkippedIssue,
  type WorktreeSettings,
} from "./auto-run.js";

export interface FrozenIssue {
  readonly number: number;
  /** The title as it was when the run started. Branches and commits use this. */
  readonly title: string;
  readonly branch: string;
  readonly disposition: IssueDisposition;
  readonly difficulty?: IssueDifficulty;
  /** Whether this issue's implementer launches with Claude in Chrome. */
  readonly chrome?: true;
  readonly dependsOn: readonly number[];
}

/** The settings a run is bound to for its whole life, including every resume. */
export interface FrozenRunSettings {
  readonly review: boolean;
  readonly recursiveIssueReferences: boolean;
  readonly mergeStrategy: MergeStrategy;
  readonly mergeRunPullRequest: boolean;
  readonly pauseAfterHitl: boolean;
  readonly pollSeconds: number;
  readonly worktree: WorktreeSettings;
  readonly workspaceRoot?: string;
  /** Configured note added before any per-run guidance. */
  readonly permanentPrompt?: string;
  /** Appended to every implementer and pr-doctor prompt for this run. */
  readonly additionalGuideline?: string;
}

export const RUN_CHECKPOINTS = [
  /** The plan is persisted; nothing has been created yet. */
  "planned",
  /** The run's own checkout exists (or was never wanted). */
  "workspace-ready",
  /** The session branch exists locally and on the remote. */
  "session-branch-ready",
  /** An issue from the plan is being worked. */
  "issue",
  /** Every plan entry is done; the run's own pull request is being settled. */
  "concluding",
  /** Terminal: the run reached its conclusion successfully. */
  "complete",
] as const;

export type RunCheckpoint = (typeof RUN_CHECKPOINTS)[number];

export type IssueProgress =
  | { readonly state: "pending" }
  | {
      readonly state: "current";
      readonly phase: AutoRunPhase;
      readonly prNumber?: number;
      /** The branch tip this run last pushed, for force-push detection. */
      readonly headSha?: string;
      readonly reviewed?: true;
    }
  | {
      readonly state: "done";
      readonly result: "landed";
      readonly prNumber: number;
      /** Whether aboard's best-effort close attempt succeeded. */
      readonly issueClosed: boolean;
    }
  | { readonly state: "done"; readonly result: "no-changes" };

export type RunAttemptOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly reason: string };

export type PendingAction =
  | { readonly kind: "create-branch"; readonly branch: string; readonly base: string; readonly baseSha: string }
  | {
      readonly kind: "commit";
      readonly branch: string;
      readonly parentSha: string;
      /** The complete subject and body passed to git. */
      readonly message: string;
      /** The exact tree the staged changes are intended to produce. */
      readonly treeSha: string;
      /** Sorted paths that were dirty when the commit was decided. */
      readonly fingerprint: readonly string[];
    }
  | { readonly kind: "push"; readonly branch: string; readonly sha: string }
  | { readonly kind: "create-issue-pr"; readonly issue: number; readonly head: string; readonly base: string }
  | { readonly kind: "merge-issue-pr"; readonly prNumber: number; readonly head: string; readonly base: string; readonly headSha: string; readonly baseSha: string }
  | { readonly kind: "create-run-pr"; readonly head: string; readonly base: string }
  | { readonly kind: "merge-run-pr"; readonly prNumber: number; readonly head: string; readonly base: string; readonly headSha: string; readonly baseSha: string };

export interface AutoRunRecord {
  readonly version: 2;
  readonly runId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** 1 for the original attempt; incremented by every resume. */
  readonly attempt: number;
  readonly settings: FrozenRunSettings;
  readonly plan: readonly FrozenIssue[];
  /** Keyed by issue number as a string, because JSON has no integer keys. */
  readonly progress: Readonly<Record<string, IssueProgress>>;
  readonly sessionBranch: string;
  readonly targetBranch: string | undefined;
  /** The target's local tip from which this run was cut. */
  readonly targetHeadSha?: string;
  /** Local target commits absent from origin when the run was frozen. */
  readonly unpublishedTargetCommits?: number;
  /** Run-owned branch name to the full SHA this run last pushed there. */
  readonly branchShas: Readonly<Record<string, string>>;
  readonly currentIssue: number | undefined;
  readonly checkpoint: RunCheckpoint;
  readonly runPullRequest?: number;
  /** Issues a pr-doctor has already reviewed; a review that finds nothing leaves no trace. */
  readonly reviewedIssues: readonly number[];
  readonly pendingAction?: PendingAction;
  readonly outcome?: RunAttemptOutcome;
  /** Set once the run's own checkout has actually been created. */
  readonly workspaceCreated?: true;
}

export type RecoveryEligibility =
  | { readonly state: "checking" }
  | { readonly state: "resumable" }
  | { readonly state: "broken"; readonly reason: string };

/** The reason a version-1 record is shown as broken rather than migrated. */
export const UNSUPPORTED_RECORD_REASON = "run predates fixed-plan recovery";

export interface UnsupportedAutoRunRecord {
  readonly version: 1;
  readonly runId: string;
  readonly startedAt: string;
}

export type PersistedAutoRunRecord = AutoRunRecord | UnsupportedAutoRunRecord;

export function isUnsupportedRecord(record: PersistedAutoRunRecord): record is UnsupportedAutoRunRecord {
  return record.version === 1;
}

export function issueProgress(record: AutoRunRecord, issueNumber: number): IssueProgress {
  return record.progress[String(issueNumber)] ?? { state: "pending" };
}

export function withProgress(record: AutoRunRecord, issueNumber: number, progress: IssueProgress): AutoRunRecord {
  return { ...record, progress: { ...record.progress, [String(issueNumber)]: progress } };
}

/** Plan entries still to work, in the plan's immutable order. */
export function remainingIssues(record: AutoRunRecord): readonly FrozenIssue[] {
  return record.plan.filter((issue) => issueProgress(record, issue.number).state !== "done");
}

export function completedCount(record: AutoRunRecord): number {
  return record.plan.filter((issue) => issueProgress(record, issue.number).state === "done").length;
}

/** Issues whose pull request reached the session branch, in plan order. */
export function landedIssues(record: AutoRunRecord): readonly { readonly number: number; readonly title: string; readonly prNumber: number }[] {
  return record.plan.flatMap((issue) => {
    const progress = issueProgress(record, issue.number);
    if (progress.state !== "done" || progress.result !== "landed") return [];
    return [{ number: issue.number, title: issue.title, prNumber: progress.prNumber }];
  });
}

export function runSucceeded(record: AutoRunRecord, runPullRequestMerged: boolean): boolean {
  if (remainingIssues(record).length > 0) return false;
  if (landedIssues(record).length === 0) return true;
  if (record.runPullRequest === undefined) return false;
  return !record.settings.mergeRunPullRequest || runPullRequestMerged;
}

/** Every branch this run owns and expects to exist, given how far it has got. */
export function runOwnedBranches(record: AutoRunRecord): readonly string[] {
  const branches = [record.sessionBranch];
  for (const issue of record.plan) {
    const progress = issueProgress(record, issue.number);
    // A landed issue's branch is deleted with its merge, and a no-changes
    // issue's branch is discarded; neither is expected to still exist.
    if (progress.state === "current") branches.push(issue.branch);
  }
  return branches;
}

export interface RunPlanResult {
  readonly issues: readonly FrozenIssue[];
  readonly skipped: readonly SkippedIssue[];
  readonly dependencyCycles: readonly (readonly number[])[];
}

export function planRun(candidates: readonly CandidateIssue[]): RunPlanResult {
  const open = candidates.filter((candidate) => candidate.state === "open");
  const skipped: SkippedIssue[] = [];
  const eligible = new Map<number, CandidateIssue>();
  for (const candidate of open) {
    const disposition = classify(candidate.labels);
    if (disposition === undefined) {
      skipped.push({ number: candidate.number, reason: "unclassified: neither [AI]-afk nor [AI]-hitl" });
      continue;
    }
    eligible.set(candidate.number, candidate);
  }

  const excluded = new Map<number, string>();
  for (;;) {
    let changed = false;
    for (const [number, candidate] of eligible) {
      const external = candidate.openBlockedByNumbers.filter((blocker) => !eligible.has(blocker));
      if (external.length === 0) continue;
      eligible.delete(number);
      excluded.set(
        number,
        `blocked by open ${external.map((blocker) => `#${blocker}`).join(", ")}, which this run cannot address`,
      );
      changed = true;
    }
    if (!changed) break;
  }
  for (const [number, reason] of [...excluded].sort((left, right) => left[0] - right[0])) {
    skipped.push({ number, reason });
  }

  const { ordered, cycles } = orderByDependencies([...eligible.values()]);
  const issues = ordered.map((candidate): FrozenIssue => {
    const difficulty = issueDifficulty(candidate.labels);
    return {
      number: candidate.number,
      title: candidate.title,
      branch: branchName(candidate.number, candidate.title),
      disposition: classify(candidate.labels)!,
      ...(difficulty === undefined ? {} : { difficulty }),
      ...(hasLabel(candidate.labels, LABEL_CHROME) ? { chrome: true as const } : {}),
      dependsOn: candidate.openBlockedByNumbers.filter((blocker) => eligible.has(blocker)),
    };
  });
  return { issues, skipped: skipped.sort((left, right) => left.number - right.number), dependencyCycles: cycles };
}

function classify(labels: readonly string[]): IssueDisposition | undefined {
  const disposition = issueDisposition(labels);
  return disposition === "unclassified" ? undefined : disposition;
}

function compareCandidates(left: CandidateIssue, right: CandidateIssue): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.number - right.number;
}

function orderByDependencies(candidates: readonly CandidateIssue[]): {
  readonly ordered: readonly CandidateIssue[];
  readonly cycles: readonly (readonly number[])[];
} {
  const byNumber = new Map(candidates.map((candidate) => [candidate.number, candidate]));
  const dependencies = new Map<number, Set<number>>();
  const dependents = new Map<number, Set<number>>();
  for (const candidate of candidates) {
    const local = new Set(candidate.dependencyNumbers.filter((number) => byNumber.has(number)));
    dependencies.set(candidate.number, local);
    for (const dependency of local) {
      const consumers = dependents.get(dependency) ?? new Set<number>();
      consumers.add(candidate.number);
      dependents.set(dependency, consumers);
    }
  }

  const remaining = new Set(byNumber.keys());
  const ordered: CandidateIssue[] = [];
  const cycles: number[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((number) => dependencies.get(number)?.size === 0)
      .map((number) => byNumber.get(number)!)
      .sort(compareCandidates);
    if (ready.length === 0) {
      const cycle = findDependencyCycle(remaining, dependencies, byNumber);
      // A finite graph with no ready node contains a cycle. The fallback is a
      // defensive escape hatch if that invariant is broken by a future edit.
      if (cycle.length === 0) {
        dependencies.get([...remaining].map((number) => byNumber.get(number)!).sort(compareCandidates)[0]!.number)?.clear();
        continue;
      }
      const members = new Set(cycle);
      cycles.push(cycle.map((number) => byNumber.get(number)!).sort(compareCandidates).map((candidate) => candidate.number));
      for (const member of members) {
        const own = dependencies.get(member)!;
        for (const dependency of [...own]) {
          if (members.has(dependency)) own.delete(dependency);
        }
      }
      continue;
    }

    const candidate = ready[0]!;
    remaining.delete(candidate.number);
    ordered.push(candidate);
    for (const dependent of dependents.get(candidate.number) ?? []) {
      dependencies.get(dependent)?.delete(candidate.number);
    }
  }
  return { ordered, cycles };
}

function findDependencyCycle(
  remaining: ReadonlySet<number>,
  dependencies: ReadonlyMap<number, ReadonlySet<number>>,
  byNumber: ReadonlyMap<number, CandidateIssue>,
): readonly number[] {
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const path: number[] = [];
  const pathPositions = new Map<number, number>();
  const starts = [...remaining].map((number) => byNumber.get(number)!).sort(compareCandidates);

  for (const start of starts) {
    if (visited.has(start.number)) continue;
    const stack: { readonly number: number; readonly next: readonly number[]; index: number }[] = [];
    const push = (number: number): void => {
      visiting.add(number);
      pathPositions.set(number, path.length);
      path.push(number);
      const next = [...(dependencies.get(number) ?? [])]
        .filter((dependency) => remaining.has(dependency))
        .map((dependency) => byNumber.get(dependency)!)
        .sort(compareCandidates)
        .map((candidate) => candidate.number);
      stack.push({ number, next, index: 0 });
    };
    push(start.number);
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const next = frame.next[frame.index++];
      if (next !== undefined) {
        if (visiting.has(next)) return path.slice(pathPositions.get(next));
        if (!visited.has(next)) push(next);
        continue;
      }
      stack.pop();
      visiting.delete(frame.number);
      visited.add(frame.number);
      pathPositions.delete(frame.number);
      path.pop();
    }
  }
  return [];
}
