/**
 * The fixed auto-run plan and its persisted record (`AGENTS.md`).
 *
 * A run discovers its issue set exactly once. Everything downstream — resume,
 * recovery validation, the Auto Run view, discard cleanup — reads the frozen
 * plan rather than GitHub, so a repository that changes underneath a run makes
 * that run visibly broken instead of quietly working on different issues than
 * the user agreed to.
 *
 * Pure: no `vscode`, no process, no clock, no I/O.
 */

import { LABEL_CHROME, LABEL_SPEC, hasLabel, issueDifficulty, issueDisposition, type IssueDifficulty } from "../shared/labels.js";
import {
  branchName,
  type AutoRunPhase,
  type CandidateIssue,
  type IssueDisposition,
  type MergeStrategy,
  type SkippedIssue,
  type WorktreeSettings,
} from "./auto-run.js";

/**
 * One issue as the run froze it. Title, branch, disposition, difficulty, and
 * dependency edges are all captured at planning time: the branch a commit lands
 * on and the tier an agent runs at must not change because somebody relabelled
 * or renamed an issue mid-run.
 */
export interface FrozenIssue {
  readonly number: number;
  /** The title as it was when the run started. Branches and commits use this. */
  readonly title: string;
  readonly branch: string;
  readonly disposition: IssueDisposition;
  readonly difficulty?: IssueDifficulty;
  /** Whether this issue's implementer launches with Claude in Chrome. */
  readonly chrome?: true;
  /**
   * Open blockers, restricted to issues this same run admitted. An issue whose
   * closure reaches outside the plan is excluded rather than carried with a
   * dangling edge, so this is always a subset of the plan's own numbers.
   */
  readonly dependsOn: readonly number[];
}

/** The settings a run is bound to for its whole life, including every resume. */
export interface FrozenRunSettings {
  readonly review: boolean;
  readonly mergeStrategy: MergeStrategy;
  readonly mergeRunPullRequest: boolean;
  readonly pauseAfterHitl: boolean;
  readonly pollSeconds: number;
  readonly worktree: WorktreeSettings;
  /**
   * Where an isolated run works, resolved once at planning time. Absent for a
   * run working in the user's own checkout.
   */
  readonly workspaceRoot?: string;
  /** Appended to every implementer and pr-doctor prompt for this run. */
  readonly additionalGuideline?: string;
}

/**
 * How far the run has got, independent of any single issue. The per-issue phase
 * lives on that issue's progress entry; this is the outer sequence a resume
 * re-enters at.
 */
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

/**
 * One plan entry's state. A discriminated union rather than a bag of optional
 * fields: "done with a landed pull request" and "done because the implementer
 * correctly changed nothing" are different facts, and recovery validation asks
 * different questions of each.
 */
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

/**
 * How an attempt ended. Distinguished because recovery treats them differently
 * in what it tells the user, and because "the user stopped this" must never be
 * reported as "the extension crashed".
 */
export type RunAttemptOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * A mutating git/GitHub action that had begun when the record was last written.
 *
 * Persisted *before* the side effect, carrying the exact before/after facts the
 * effect is meant to produce. After a crash the postcondition is adopted only
 * when it matches this journal entry exactly, which closes the "side effect
 * succeeded but the record save did not" window without ever adopting unrelated
 * external work as the run's own.
 */
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

/**
 * The version-2 authoritative run record. Unlike the version-1 resume hint it
 * replaces, this is the source of truth for what the run is doing: the engine
 * validates the repository *against* it rather than re-deriving a plan from the
 * repository.
 */
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
  /**
   * The branch the user was on when the run started, and where the run's own
   * pull request goes. `undefined` only for a detached HEAD, where the default
   * branch stands in.
   */
  readonly targetBranch: string | undefined;
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

/**
 * Whether a recorded run can be continued. Derived from the record plus fresh
 * observations, never stored: a run that was resumable a minute ago is broken
 * the moment somebody force-pushes its branch.
 */
export type RecoveryEligibility =
  | { readonly state: "checking" }
  | { readonly state: "resumable" }
  | { readonly state: "broken"; readonly reason: string };

/** The reason a version-1 record is shown as broken rather than migrated. */
export const UNSUPPORTED_RECORD_REASON = "run predates fixed-plan recovery";

/**
 * A version-1 record cannot become a fixed plan: it stored issue numbers as a
 * forecast, re-derived from GitHub on every resume, and carries none of the
 * SHAs, dispositions, or per-issue outcomes recovery validation needs. Rather
 * than disappear (losing the user's only pointer at in-flight work) or resume
 * dynamically (the behavior this replaces), it surfaces as an unsupported
 * interrupted run offering Discard.
 */
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

/**
 * Whether the run reached its own definition of success: every plan entry done,
 * and — when anything landed — the run's pull request opened, plus merged if
 * that was frozen on. A run whose every issue needed no change succeeds with no
 * pull request at all, because there is nothing to carry anywhere.
 */
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

/**
 * The exclusion reasons planning can report. Short by design: they are read in
 * bulk at start, one line per skipped issue.
 */
export interface RunPlanResult {
  readonly issues: readonly FrozenIssue[];
  readonly skipped: readonly SkippedIssue[];
  readonly dependencyCycles: readonly (readonly number[])[];
}

/**
 * Plans a run over the whole open issue graph, once.
 *
 * Admission is closed under dependencies: a blocked issue joins the plan when
 * every open blocker is also in the plan, because this run will address those
 * blockers before reaching it. An issue whose dependency closure reaches
 * something this run cannot address is excluded recursively — implementing it
 * against an unmet premise is worse than deferring it to a later run.
 *
 * Unclassified is reported, never guessed at. An umbrella — `[AI]-spec`, or any
 * issue with sub-issues — never enters the plan, silently unless it is also
 * classified, because an umbrella asking to be addressed autonomously is a
 * genuine contradiction rather than ordinary noise.
 */
export function planRun(candidates: readonly CandidateIssue[]): RunPlanResult {
  const open = candidates.filter((candidate) => candidate.state === "open");
  const skipped: SkippedIssue[] = [];
  const eligible = new Map<number, CandidateIssue>();
  for (const candidate of open) {
    const disposition = classify(candidate.labels);
    const umbrella = umbrellaReason(candidate);
    if (umbrella !== undefined) {
      if (disposition !== undefined) skipped.push({ number: candidate.number, reason: umbrella });
      continue;
    }
    if (disposition === undefined) {
      skipped.push({ number: candidate.number, reason: "unclassified: neither [AI]-afk nor [AI]-hitl" });
      continue;
    }
    eligible.set(candidate.number, candidate);
  }

  // Fixpoint: drop anything blocked by work this run will not do, then drop
  // whatever that decision in turn strands. Terminates because every pass either
  // removes at least one member or stops.
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

function umbrellaReason(candidate: CandidateIssue): string | undefined {
  if (hasLabel(candidate.labels, LABEL_SPEC)) {
    return `umbrella: labelled ${LABEL_SPEC}, so its children are the work`;
  }
  return candidate.hasChildren ? "umbrella: has sub-issues, which are the work" : undefined;
}

function compareCandidates(left: CandidateIssue, right: CandidateIssue): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.number - right.number;
}

/**
 * Stable Kahn sort with surgical cycle breaking. When no node is ready, a DFS
 * identifies one actual directed cycle; removing only the edges inside it keeps
 * every acyclic constraint around it intact. Both walks carry explicit visited
 * state and therefore terminate for every finite input graph.
 */
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
