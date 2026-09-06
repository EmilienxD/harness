
import type { IssueDifficulty } from "../shared/labels.js";

export const AUTO_RUN_PHASES = [
  "branch",
  "implement",
  "commit",
  "pr",
  "review",
  "await-approval",
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
  /** Whether a read-only Explore worker prepares fresh context for each fresh implementer. */
  readonly exploreBeforeImplement: boolean;
  /** Whether issue context follows references beyond the primary issue's direct references. */
  readonly recursiveIssueReferences: boolean;
  /** Persistent user-authored note added to every auto-run agent prompt. */
  readonly permanentPrompt: string;
  readonly discardBehavior: DiscardBehavior;
  readonly pauseAfterHitl: boolean;
  readonly mergeStrategy: MergeStrategy;
  readonly pollSeconds: number;
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
      readonly exploresBeforeImplement: boolean;
      readonly branchMode?: AutoRunBranchMode;
      readonly pauseAfterHitl: boolean;
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
  readonly commitPushed: boolean;
  readonly pullRequest: PullRequestFacts | undefined;
  /** Whether a pr-doctor has already run against the open pull request. */
  readonly reviewed: boolean;
  readonly issueClosed: boolean;
}

export interface PullRequestFacts {
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly approvedByOther: boolean;
}

export type AutoRunStep =
  | { readonly action: "branch"; readonly branch: string; readonly base: string }
  | { readonly action: "implement"; readonly issue: PlannedIssue }
  | { readonly action: "commit"; readonly issue: PlannedIssue }
  | { readonly action: "pr"; readonly issue: PlannedIssue }
  | { readonly action: "review"; readonly issue: PlannedIssue; readonly prNumber: number }
  | { readonly action: "await-approval"; readonly issue: PlannedIssue; readonly prNumber: number }
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
      case "implement":
        // A commit or a pull request already carries the implementation; a dirty
        // tree on the right branch is an implementation waiting to be committed.
        if (facts.hasCommit || facts.pullRequest !== undefined || facts.workingTreeDirty) continue;
        return { action: "implement", issue };
      case "commit":
        if (facts.hasCommit && facts.commitPushed && !facts.workingTreeDirty) continue;
        // Reachable on resume: a pull request exists, so the `implement` phase
        // was satisfied, yet the branch carries nothing to commit.
        if (!facts.workingTreeDirty && !facts.hasCommit) {
          return { action: "stop", reason: `the implementer produced no changes for issue #${issue.number}` };
        }
        return { action: "commit", issue };
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
      case "await-approval": {
        const pr = requirePullRequest(facts, issue);
        if (pr.action === "stop") return pr;
        if (issue.disposition === "afk") continue;
        if (facts.pullRequest?.state === "closed") {
          return { action: "stop", reason: `pull request #${pr.number} was closed without merging, so issue #${issue.number} was rejected` };
        }
        // A third-party approval is the secondary signal; the extension cannot
        // approve its own pull request, so the user's merge is the primary one.
        if (facts.pullRequest?.approvedByOther === true) continue;
        return { action: "await-approval", issue, prNumber: pr.number };
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

export interface ImplementerCompletion {
  readonly commitMessage: string;
  readonly report: string;
}

export type ImplementerCompletionParseResult =
  | { readonly accepted: true; readonly completion: ImplementerCompletion }
  | { readonly accepted: false; readonly reason: string };

const COMMIT_BLOCK = /<commit>([\s\S]*?)<\/commit>/gu;

/** Positive evidence that an implementer considers the whole issue ready to commit. */
export function parseImplementerCompletion(message: string): ImplementerCompletionParseResult {
  const matches = [...message.matchAll(COMMIT_BLOCK)];
  const openingTags = message.match(/<commit>/gu)?.length ?? 0;
  const closingTags = message.match(/<\/commit>/gu)?.length ?? 0;
  if (matches.length !== 1 || openingTags !== 1 || closingTags !== 1) {
    return {
      accepted: false,
      reason: openingTags === 0 && closingTags === 0
        ? "the implementer did not confirm that the issue is complete"
        : "the implementer returned a malformed or repeated commit block",
    };
  }

  const commitMessage = matches[0]?.[1]?.trim() ?? "";
  if (commitMessage.length === 0) return { accepted: false, reason: "the implementer returned an empty commit block" };
  if (/\r|\n/u.test(commitMessage)) return { accepted: false, reason: "the implementer's commit message must be one line" };
  if (/\p{Cc}/u.test(commitMessage)) return { accepted: false, reason: "the implementer's commit message contains a control character" };
  if (commitMessage.length > COMMIT_SUBJECT_MAX_CHARS) {
    return { accepted: false, reason: `the implementer's commit message exceeds ${COMMIT_SUBJECT_MAX_CHARS} characters` };
  }

  const match = matches[0];
  const start = match?.index ?? 0;
  const before = message.slice(0, start).trimEnd();
  const after = message.slice(start + (match?.[0].length ?? 0)).trimStart();
  const report = [before, after].filter((part) => part.length > 0).join("\n\n");
  return { accepted: true, completion: { commitMessage, report } };
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

export function issueCommentBody(summary: string, commitMessage?: string): string | undefined {
  const report = summary.trim();
  const heading = commitMessage === undefined ? "" : `**${escapeMarkdownInline(commitMessage)}**`;
  const trimmed = [heading, report].filter((part) => part.length > 0).join("\n\n");
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

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\*_`[\]])/gu, "\\$1");
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
  unchanged: (issue: number): string =>
    `auto-run: issue #${issue} finished with no changes; deleted its empty branch and continuing.`,
  committed: (issue: number, sha: string, pr: number): string => `auto-run: issue #${issue} committed (${sha}) and opened PR #${pr}.`,
  reviewed: (issue: number, paths: readonly string[]): string =>
    `auto-run: issue #${issue} reviewed; committing ${paths.length === 0 ? "no further changes" : `${paths.length} changed path(s): ${paths.slice(0, 10).join(", ")}`}.`,
  captured: (issue: number, pr: number, paths: readonly string[]): string =>
    `auto-run: committed ${paths.length} changed path(s) from issue #${issue}'s open terminals to PR #${pr}: ${paths.slice(0, 10).join(", ")}.`,
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
  waiting: (issue: number, pr: number): string => `auto-run: issue #${issue} is hitl; PR #${pr} is open and waiting for you. The run is paused.`,
  resolved: (pr: number): string => `auto-run: PR #${pr} merged by you; continuing.`,
  stopped: (issue: number | undefined, reason: string): string =>
    `auto-run: stopped${issue === undefined ? "" : ` at issue #${issue}`} (${reason}). Branch and work left in place.`,
  returnBlocked: (target: string, current: string, paths: readonly string[]): string =>
    `auto-run: stayed on ${current} instead of returning to ${target}; uncommitted work remains in ${paths.length} path(s): ${paths.slice(0, 10).join(", ")}. Resume the run or inspect it there.`,
  complete: (count: number, parked: number): string =>
    `auto-run: plan drained (${count} issue${count === 1 ? "" : "s"} addressed${parked === 0 ? "" : `, ${parked} left for you`}). Start another run once more work is labelled.`,
  returned: (branch: string): string => `auto-run: back on ${branch}.`,
} as const;
