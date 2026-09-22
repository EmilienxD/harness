
import type { IssueDifficulty } from "../shared/labels.js";

export const AUTO_RUN_PHASES = [
  "branch",
  "address",
  "await-commit",
  "publish",
  "pr",
  "review",
  "merge",
  "cleanup",
] as const;

export type AutoRunPhase = (typeof AUTO_RUN_PHASES)[number];

export type IssueDisposition = "afk" | "hitl";

/** Branches in this namespace are automation artifacts, never run targets. */
export const RUN_OWNED_BRANCH_PREFIXES = ["issue/", "run/"] as const;

export function isAboardBranch(branch: string): boolean {
  return RUN_OWNED_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix));
}

export function autoRunTargetBranchBlocker(branch: string): string | undefined {
  if (!isAboardBranch(branch)) return undefined;
  return `auto-run cannot start from ${branch} because issue/* and run/* branches are run-owned artifacts; check out the branch that should receive the final run pull request and start again`;
}

export function unpublishedTargetWarning(base: string, count: number): string {
  return `${base} has ${count} commit${count === 1 ? "" : "s"} not on origin/${base}; the run will include them. Push ${base} before squash/rebase merging the final PR, or use a merge commit.`;
}

export const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

/**
 * Relation levels preloaded around each requested issue. `0` is the requested
 * issues alone; `1` adds their direct parents, sub-issues, and references; each
 * further level continues the traversal by one more hop.
 */
export const DEFAULT_ISSUE_CONTEXT_DEPTH = 1;
export const MAX_ISSUE_CONTEXT_DEPTH = 10;

export const AUTO_RUN_BRANCH_MODES = ["per-issue", "single-branch"] as const;
export type AutoRunBranchMode = (typeof AUTO_RUN_BRANCH_MODES)[number];

export interface WorktreeSettings {
  readonly enabled: boolean;
  readonly root: string;
  /** Keep the checkout after a run that would otherwise remove it. */
  readonly keep: boolean;
  readonly setupTimeoutSeconds: number;
}

export const DISCARD_BEHAVIORS = ["record-only", "local-cleanup", "full-cleanup"] as const;
export type DiscardBehavior = (typeof DISCARD_BEHAVIORS)[number];

export interface AutoRunSettings {
  readonly branchMode?: AutoRunBranchMode;
  readonly review: boolean;
  /** Whether a read-only explore worker prepares fresh context for each fresh address. */
  readonly exploreBeforeAddress: boolean;
  /** How many relation levels of issue context are preloaded around each issue. */
  readonly issueContextDepth: number;
  /** Persistent user-authored note added to every auto-run agent prompt. */
  readonly permanentPrompt: string;
  readonly discardBehavior: DiscardBehavior;
  readonly mergeStrategy: MergeStrategy;
  readonly mergeRunPullRequest: boolean;
  readonly worktree: WorktreeSettings;
}

export interface PlannedIssue {
  readonly number: number;
  readonly title: string;
  readonly disposition: IssueDisposition;
  readonly branch: string;
  /** Whether the issue carries `[AI]-chrome`. */
  readonly chrome?: true;
  readonly difficulty?: IssueDifficulty;
}

export interface SkippedIssue {
  readonly number: number;
  readonly reason: string;
}

export type AutoRunDryRunResult =
  | {
      readonly dryRun: true;
      readonly inspected: false;
      readonly reason: string;
    }
  | {
      readonly dryRun: true;
      readonly inspected: true;
      readonly ready: boolean;
      readonly blockers: readonly string[];
      /** Important facts the user should review which do not prevent a start. */
      readonly warnings: readonly string[];
      /**
       * Why the plan is empty, when it is. An empty queue is the ordinary state
       * of a project with nothing labelled, not a problem to fix, so it is kept
       * apart from the blockers that actually prevent a start.
       */
      readonly emptyReason: string | undefined;
      readonly reviewMode: boolean;
      readonly exploresBeforeAddress: boolean;
      readonly branchMode?: AutoRunBranchMode;
      /** Persistent configured note that would be added to every auto agent. */
      readonly permanentPrompt?: string;
      /** User-authored guidance that would be appended to every auto agent. */
      readonly additionalGuideline?: string;
      readonly isolatedWorkspace: boolean;
      readonly keepsWorkspace: boolean;
      readonly sessionBranch: "run/<run-id>";
      readonly sessionBase: string;
      /** Full local target tip inspected for this forecast. */
      readonly targetHeadSha: string;
      /** Commits on the local target which origin does not yet contain. */
      readonly unpublishedTargetCommits: number;
      readonly mergesItsOwnPullRequest: boolean;
      readonly issues: readonly PlannedIssue[];
      readonly skipped: readonly SkippedIssue[];
      readonly dependencyCycles: readonly (readonly number[])[];
    };

/** Everything the engine observed about the repository for the current issue. */
export interface RepositoryFacts {
  readonly currentBranch: string | undefined;
  readonly branchExists: boolean;
  readonly workingTreeDirty: boolean;
  /** Paths reported dirty, used to name them in a refusal or a notification. */
  readonly dirtyPaths: readonly string[];
  readonly hasCommit: boolean;
  readonly awaitingCommit?: boolean;
  /** A HITL implementation checkpoint is exposed and its review still needs to run or continue. */
  readonly hitlReviewPending?: boolean;
  readonly implementationSha?: string;
  readonly commitPushed: boolean;
  readonly pullRequest: PullRequestFacts | undefined;
  /** Whether a review has already run against the open pull request. */
  readonly reviewed: boolean;
  readonly issueClosed: boolean;
}

export interface PullRequestFacts {
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
}

export type AutoRunStep =
  | { readonly action: "branch"; readonly branch: string; readonly base: string }
  | { readonly action: "address"; readonly issue: PlannedIssue }
  | { readonly action: "publish"; readonly issue: PlannedIssue }
  | { readonly action: "await-commit"; readonly issue: PlannedIssue }
  | { readonly action: "pr"; readonly issue: PlannedIssue }
  | { readonly action: "review"; readonly issue: PlannedIssue; readonly prNumber: number }
  | { readonly action: "merge"; readonly issue: PlannedIssue; readonly prNumber: number }
  | { readonly action: "cleanup"; readonly issue: PlannedIssue }
  | { readonly action: "advance" }
  | { readonly action: "stop"; readonly reason: string };

export interface ReducerInput {
  readonly issue: PlannedIssue;
  readonly baseBranch: string;
  readonly reviewMode: boolean;
  readonly facts: RepositoryFacts;
}

export function nextStep(input: ReducerInput): AutoRunStep {
  const { issue, facts, reviewMode } = input;
  if (facts.hitlReviewPending) return { action: "address", issue };
  if ((facts.hasCommit || facts.pullRequest !== undefined) && facts.implementationSha === undefined && !facts.awaitingCommit) return { action: "stop", reason: `issue #${issue.number} has no recorded accepted implementation` };
  if (facts.awaitingCommit) return { action: "await-commit", issue };
  if (facts.issueClosed) return { action: "cleanup", issue };
  if (facts.pullRequest?.state === "merged") return { action: "cleanup", issue };
  for (const phase of AUTO_RUN_PHASES) {
    switch (phase) {
      case "branch":
        if (facts.branchExists && facts.currentBranch === issue.branch) continue;
        if (facts.workingTreeDirty) {
          return {
            action: "stop",
            reason: `the repository is on ${facts.currentBranch ?? "a detached HEAD"} with uncommitted work, but issue #${issue.number} belongs on ${issue.branch}`,
          };
        }
        return { action: "branch", branch: issue.branch, base: input.baseBranch };
      case "address":
        if (facts.implementationSha !== undefined) continue;
        if (facts.workingTreeDirty) return { action: "stop", reason: dirtyReason(issue, facts) };
        return { action: "address", issue };
      case "await-commit":
        continue;
      case "publish":
        if (facts.workingTreeDirty) return { action: "stop", reason: dirtyReason(issue, facts) };
        if (!facts.hasCommit) {
          return { action: "stop", reason: `address-this produced no commit for issue #${issue.number}` };
        }
        if (facts.commitPushed) continue;
        return { action: "publish", issue };
      case "pr": {
        if (facts.pullRequest !== undefined) continue;
        return { action: "pr", issue };
      }
      case "review": {
        const pr = requirePullRequest(facts, issue);
        if (pr.action === "stop") return pr;
        if (!reviewMode || facts.reviewed) continue;
        return { action: "review", issue, prNumber: pr.number };
      }
      case "merge": {
        const pr = requirePullRequest(facts, issue);
        if (pr.action === "stop") return pr;
        if (facts.pullRequest?.state === "closed") {
          return { action: "stop", reason: `pull request #${pr.number} was closed without merging, so issue #${issue.number} was rejected` };
        }
        return { action: "merge", issue, prNumber: pr.number };
      }
      case "cleanup":
        return { action: "cleanup", issue };
    }
  }
  return { action: "advance" };
}

function dirtyReason(issue: PlannedIssue, facts: RepositoryFacts): string {
  const paths = facts.dirtyPaths.slice(0, 10).join(", ");
  return `issue #${issue.number} has uncommitted changes on ${facts.currentBranch ?? "a detached HEAD"}${paths.length === 0 ? "" : ` (${paths})`}; the workers commit their own work, so the run stops for you to inspect the checkout`;
}

type PullRequestOr = { readonly action: "stop"; readonly reason: string } | { readonly action: "found"; readonly number: number };

function requirePullRequest(facts: RepositoryFacts, issue: PlannedIssue): PullRequestOr {
  if (facts.pullRequest === undefined) {
    return { action: "stop", reason: `no pull request exists for issue #${issue.number}` };
  }
  return { action: "found", number: facts.pullRequest.number };
}

export function branchName(issueNumber: number, title: string): string {
  return `issue/${issueNumber}-${slugify(title)}`;
}

export function sessionBranchName(runId: string): string {
  return `run/${slugify(runId.replace(/^run_/u, ""))}`;
}

const SLUG_MAX_CHARS = 40;

export function slugify(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (normalized.length === 0) return "issue";
  if (normalized.length <= SLUG_MAX_CHARS) return normalized;
  const cut = normalized.slice(0, SLUG_MAX_CHARS + 1);
  const boundary = cut.lastIndexOf("-");
  // Without a boundary the first word alone already exceeds the budget; a hard
  // cut is then the only option that keeps the name bounded.
  const truncated = boundary > 0 ? cut.slice(0, boundary) : normalized.slice(0, SLUG_MAX_CHARS);
  return truncated.replace(/-+$/u, "") || "issue";
}

/** Commit subjects stay bounded so `git log --oneline` remains readable. */
export const COMMIT_SUBJECT_MAX_CHARS = 72;

export function commitSubject(title: string): string {
  const trimmed = title.trim();
  return trimmed.length <= COMMIT_SUBJECT_MAX_CHARS ? trimmed : `${trimmed.slice(0, COMMIT_SUBJECT_MAX_CHARS - 1).trimEnd()}…`;
}

/** The two commit-signaling Harness worker skills, named as the user invokes them. */
export type WorkerRole = "address-this" | "review-this";

/**
 * What the run's checkout looked like immediately after a worker exited. It is
 * repository state only: no part of the worker's final response is inspected,
 * so a worker needs no machine-readable completion markup.
 */
export interface WorkerRepositoryState {
  /** The tip aboard recorded before launching the worker. */
  readonly startingSha: string;
  readonly headSha: string;
  /** Paths still dirty: staged, unstaged, or untracked alike. */
  readonly dirtyPaths: readonly string[];
  /** Whether the starting commit is still reachable from `headSha`. */
  readonly descendsFromStart: boolean;
  /** Commits reachable from `headSha` but not from `startingSha`. */
  readonly newCommitCount: number;
  /** Whether the sole descendant commit changes the tree at the acceptance boundary. */
  readonly commitIsNonEmpty?: boolean;
}

export type WorkerOutcome =
  | { readonly kind: "committed"; readonly sha: string }
  | { readonly kind: "rejected"; readonly reason: string; readonly recoverable?: true };

/** User acceptance is exactly one non-empty clean commit on the recorded checkout. */
export function classifyHitlCommit(
  state: WorkerRepositoryState,
  currentBranch: string | undefined,
  expectedBranch: string,
): WorkerOutcome | { readonly kind: "waiting" } {
  if (currentBranch !== expectedBranch) return { kind: "rejected", reason: `the checkout moved to ${currentBranch ?? "a detached HEAD"}; expected ${expectedBranch}` };
  if (!state.descendsFromStart) return { kind: "rejected", reason: "HITL work moved HEAD off the recorded starting commit" };
  if (state.headSha === state.startingSha) return { kind: "waiting" };
  if (state.newCommitCount !== 1) return { kind: "rejected", reason: `HITL acceptance must contain exactly one descendant commit; found ${state.newCommitCount}` };
  if (state.commitIsNonEmpty !== true) return { kind: "rejected", reason: "the HITL acceptance commit is empty relative to the recorded starting commit" };
  if (state.dirtyPaths.length > 0) {
    return {
      kind: "rejected",
      reason: `the HITL acceptance commit left ${state.dirtyPaths.length} uncommitted path(s); include them by amending the same commit, then Resume Auto Run`,
      recoverable: true,
    };
  }
  return { kind: "committed", sha: state.headSha };
}

/** Decides a worker's success from process-independent repository state alone. */
export function classifyWorkerResult(role: WorkerRole, state: WorkerRepositoryState): WorkerOutcome {
  // A commit followed by more uncommitted edits is unsuccessful, so the dirty
  // check comes first and applies whether or not a commit was also created.
  if (state.dirtyPaths.length > 0) {
    return {
      kind: "rejected",
      reason: `${role} left ${state.dirtyPaths.length} uncommitted path(s) in the checkout: ${state.dirtyPaths.slice(0, 10).join(", ")}`,
    };
  }
  if (state.headSha === state.startingSha) {
    return { kind: "rejected", reason: `${role} finished without committing anything on top of ${state.startingSha.slice(0, 8)}` };
  }
  if (!state.descendsFromStart) {
    return { kind: "rejected", reason: `${role} moved HEAD off ${state.startingSha.slice(0, 8)} instead of committing on top of it` };
  }
  if (state.newCommitCount !== 1) {
    return { kind: "rejected", reason: `${role} created ${state.newCommitCount} commits; exactly one is allowed` };
  }
  return { kind: "committed", sha: state.headSha };
}

export const PR_BODY_MAX_CHARS = 4_000;

export function pullRequestBody(summary: string, issueNumber: number): string {
  const trimmed = summary.trim();
  const bounded = trimmed.length <= PR_BODY_MAX_CHARS ? trimmed : `${trimmed.slice(0, PR_BODY_MAX_CHARS - 1).trimEnd()}…`;
  return bounded.length === 0 ? `Closes #${issueNumber}` : `${bounded}\n\nCloses #${issueNumber}`;
}

/** One issue whose pull request merged into the session branch. */
export interface LandedIssue {
  readonly number: number;
  readonly title: string;
  readonly prNumber: number;
}

export function runPullRequestTitle(landed: readonly LandedIssue[]): string {
  return landed.length === 1
    ? commitSubject(landed[0]!.title)
    : `${landed.length} issues`;
}

export function runPullRequestBody(
  landed: readonly LandedIssue[],
  sessionBranch: string,
  base: string,
  unpublishedTargetCommits = 0,
  branchMode: AutoRunBranchMode = "per-issue",
): string {
  const lines = landed.map((issue) => `- #${issue.number} ${commitSubject(issue.title)}${branchMode === "per-issue" ? ` (PR #${issue.prNumber})` : ""}`);
  const warning = unpublishedTargetCommits === 0 ? [] : [
    "",
    `> [!WARNING]`,
    `> This run started with ${unpublishedTargetCommits} commit${unpublishedTargetCommits === 1 ? "" : "s"} on \`${base}\` that \`origin/${base}\` did not contain. Before squash- or rebase-merging, push \`${base}\` so GitHub removes those commits from this pull request. Otherwise use a merge commit to preserve their ancestry.`,
  ];
  const body = [
    `Addresses the completed work on \`${sessionBranch}\`.`,
    ...warning,
    "",
    ...lines,
    "",
    branchMode === "single-branch"
      ? `Each accepted issue was committed directly to \`${sessionBranch}\` and explicitly closed; this cumulative pull request carries all of it to \`${base}\`.`
      : `Each issue was merged into \`${sessionBranch}\` and closed as it landed; this pull request carries all of it to \`${base}\`.`,
  ].join("\n");
  return body.length <= PR_BODY_MAX_CHARS ? body : `${body.slice(0, PR_BODY_MAX_CHARS - 1).trimEnd()}…`;
}

export function issueClosedComment(prNumber: number, sessionBranch: string, base: string): string {
  return `Merged into \`${sessionBranch}\` in pull request #${prNumber}, and closed here because a merge outside the default branch does not close its issue. The work reaches \`${base}\` when the run's pull request merges.`;
}

export const ISSUE_COMMENT_MAX_CHARS = 65_536;

export function issueCommentBody(summary: string): string | undefined {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= ISSUE_COMMENT_MAX_CHARS ? trimmed : `${trimmed.slice(0, ISSUE_COMMENT_MAX_CHARS - 1).trimEnd()}…`;
}

const EXPLORATION_COMMENT_PREFIX = "## Codebase context\n\n_Generated from `";
const EXPLORATION_COMMENT_PATTERN = /^## Codebase context\n\n_Generated from `[0-9a-f]{12}` and its current working tree immediately before implementation\._\n\n/u;

export function isAutoRunExplorationComment(body: string): boolean {
  return EXPLORATION_COMMENT_PATTERN.test(body.trimStart());
}

export function explorationCommentBody(input: {
  readonly runId: string;
  readonly issueNumber: number;
  readonly headSha: string;
  readonly report: string;
}): string {
  const body = `${EXPLORATION_COMMENT_PREFIX}${input.headSha.slice(0, 12)}\` and its current working tree immediately before implementation._\n\n${input.report.trim()}`;
  return issueCommentBody(body) ?? body;
}

/** A candidate issue as GitHub reports it, before selection filters it. */
export interface CandidateIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  readonly openBlockedByNumbers: readonly number[];
  /** Native blockers, sub-issues, and issue-body references used for ordering. */
  readonly dependencyNumbers: readonly number[];
  /** Creation time, which breaks ties between dependency-ready issues. */
  readonly createdAt: string;
}

/** Notification lines. Kept terse on purpose; they are read in bulk. */
export const autoRunMessage = {
  started: (afk: number, hitl: number, review: boolean): string =>
    `auto-run: started; ${afk + hitl} issue${afk + hitl === 1 ? "" : "s"} queued (${afk} afk, ${hitl} hitl), review ${review ? "on" : "off"}.`,
  implemented: (issue: number, branch: string): string => `auto-run: issue #${issue} addressed on ${branch}.`,
  committed: (issue: number, sha: string, pr: number): string => `auto-run: issue #${issue} committed (${sha}) and opened PR #${pr}.`,
  reviewed: (issue: number, sha: string): string =>
    `auto-run: issue #${issue} reviewed; review committed (${sha.slice(0, 8)}).`,
  workspace: (path: string): string =>
    `auto-run: working in its own checkout at ${path}; your files stay as they are and nothing this run does touches them.`,
  workspaceKept: (path: string, reason: "kept-by-setting" | "left-for-the-user" | "removal-failed"): string => {
    const why = reason === "kept-by-setting"
      ? "aboard.autoRun.worktree.keep is on"
      : reason === "removal-failed"
        ? "it could not be removed, usually because a shell is still open in it"
        : "the run left terminals and unfinished work in it";
    return `auto-run: its checkout is still at ${path} (${why}). Remove it with git worktree remove when you are done with it.`;
  },
  setup: (command: string): string => `auto-run: running ${command} in the run's checkout.`,
  session: (branch: string, base: string): string =>
    `auto-run: every issue lands on ${branch}; the run opens one pull request into ${base} when it ends.`,
  baseNotOnRemote: (base: string): string =>
    `auto-run: ${base} is not on origin, so the run cannot open its pull request against it. Push ${base} before the run ends, or open the pull request yourself afterwards.`,
  merged: (issue: number, branch: string): string => `auto-run: issue #${issue} merged into ${branch}.`,
  // Said out loud because it is aboard's own doing, and because a reader who
  // knows GitHub's rule would otherwise wonder what closed the issue.
  closed: (issue: number): string =>
    `auto-run: issue #${issue} closed by aboard; a merge outside the default branch does not close its issue.`,
  notClosed: (issue: number, reason: string): string =>
    `auto-run: issue #${issue} merged but could not be closed (${reason}). Close it yourself: issues that depend on it stay blocked until you do.`,
  runOpened: (pr: number, base: string, count: number): string =>
    `auto-run: opened PR #${pr} into ${base} with ${count} issue${count === 1 ? "" : "s"}.`,
  unpublishedTarget: (base: string, count: number): string =>
    `auto-run: ${unpublishedTargetWarning(base, count)}`,
  runWaiting: (pr: number, base: string): string =>
    `auto-run: PR #${pr} into ${base} is yours to merge (aboard.autoRun.mergeRunPullRequest is off).`,
  runMerged: (pr: number, base: string): string =>
    `auto-run: PR #${pr} merged into ${base}. Pull ${base} to get the work.`,
  unsafeRunMerge: (pr: number, base: string, strategy: MergeStrategy): string =>
    `auto-run: PR #${pr} was left open because ${base} still has unpublished commits included in it; ${strategy} would rewrite their ancestry. Push ${base} and resume, or merge the PR with a merge commit.`,
  runParked: (pr: number, base: string, reason: string): string =>
    `auto-run: PR #${pr} into ${base} needs you (${reason}). The session branch and its pull request are left in place.`,
  runNotOpened: (branch: string, base: string, reason: string): string =>
    `auto-run: the run's work is committed and pushed on ${branch}, but no pull request into ${base} could be opened (${reason}). Open it yourself when you are ready.`,
  reconciled: (issue: number, pr: number, base: string): string =>
    `auto-run: issue #${issue} conflicted with ${base}; merged ${base} into its branch and pushed before retrying PR #${pr}.`,
  parked: (issue: number, pr: number, reason: string): string =>
    `auto-run: issue #${issue} parked; PR #${pr} needs you (${reason}). Its branch, terminals, and pull request are left in place; the run continues with the next issue.`,
  waiting: (issue: number): string => `Waiting for acceptance commit for issue #${issue}. Create exactly one non-empty commit containing all accepted changes; Auto Run continues automatically when the checkout is clean.`,
  stopped: (issue: number | undefined, reason: string): string =>
    `auto-run: stopped${issue === undefined ? "" : ` at issue #${issue}`} (${reason}). Branch and work left in place.`,
  returnBlocked: (target: string, current: string, paths: readonly string[]): string =>
    `auto-run: stayed on ${current} instead of returning to ${target}; uncommitted work remains in ${paths.length} path(s): ${paths.slice(0, 10).join(", ")}. Resume the run or inspect it there.`,
  complete: (count: number, parked: number): string =>
    `auto-run: plan drained (${count} issue${count === 1 ? "" : "s"} addressed${parked === 0 ? "" : `, ${parked} left for you`}). Start another run once more work is labelled.`,
  returned: (branch: string): string => `auto-run: back on ${branch}.`,
} as const;
