/**
 * The auto-run phase reducer (`AGENTS.md`).
 *
 * Pure: no `vscode`, no process, no clock, no I/O. Given a run record and the
 * repository facts the engine observed, it returns the next step or the terminal
 * outcome. Every phase is postcondition-checked here rather than in the driver,
 * because resume correctness is exactly "re-enter at the first unsatisfied
 * postcondition" and that decision must be testable without fakes.
 */

import { LABEL_SPEC, hasLabel, issueDifficulty, issueDisposition, type IssueDifficulty } from "../shared/labels.js";

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

export const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

/**
 * Whether a run works in the user's own checkout or in a private one of its own.
 *
 * Off by default: a separate checkout costs a full copy of the tree and whatever
 * the project's setup command installs into it, which is a price only a user who
 * wants their own working tree left alone should pay.
 */
export interface WorktreeSettings {
  readonly enabled: boolean;
  /**
   * Where the run's checkout is created. Empty means the derived default, a
   * sibling of the project root — never inside it, or the run would be
   * addressing issues in a directory the repository itself contains.
   */
  readonly root: string;
  /** Keep the checkout after a run that would otherwise remove it. */
  readonly keep: boolean;
  readonly setupTimeoutSeconds: number;
}

/**
 * What Discard removes besides the run record. The default leaves everything in
 * place: a user discarding a broken run is usually about to go and look at its
 * branches, and a cleanup that ran first would take the evidence with it.
 */
export const DISCARD_BEHAVIORS = ["record-only", "local-cleanup", "full-cleanup"] as const;
export type DiscardBehavior = (typeof DISCARD_BEHAVIORS)[number];

export interface AutoRunSettings {
  readonly review: boolean;
  readonly discardBehavior: DiscardBehavior;
  readonly pauseAfterHitl: boolean;
  readonly mergeStrategy: MergeStrategy;
  readonly pollSeconds: number;
  /**
   * Whether the run merges its own pull request into the branch the user was on
   * when it started. Off by default: that branch is one a human is actively
   * working on, and landing a batch of automated work on it is exactly the kind
   * of decision the user has to be able to see and refuse.
   */
  readonly mergeRunPullRequest: boolean;
  readonly worktree: WorktreeSettings;
}

export interface PlannedIssue {
  readonly number: number;
  readonly title: string;
  readonly disposition: IssueDisposition;
  readonly branch: string;
  /**
   * The tier the issue's difficulty label expresses, which decides the model and
   * effort of the agents that work it. Absent is the ordinary state of an issue
   * nobody rated, and resolves to the most capable tier at launch time. Derived
   * here and never persisted: the run record re-reads GitHub on resume, so a
   * relabelled issue is worked at its new tier rather than its recorded one.
   */
  readonly difficulty?: IssueDifficulty;
}

export interface SkippedIssue {
  readonly number: number;
  readonly reason: string;
}

/**
 * A read-only forecast of the next run. The session branch uses a placeholder
 * because a dry run deliberately does not mint or persist a run id; every issue
 * branch and the final target are exact for the repository state inspected.
 */
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
      readonly reviewMode: boolean;
      readonly pauseAfterHitl: boolean;
      readonly chromeEnabled: boolean;
      /** User-authored guidance that would be appended to every auto agent. */
      readonly additionalGuideline?: string;
      readonly isolatedWorkspace: boolean;
      readonly keepsWorkspace: boolean;
      readonly sessionBranch: "aboard/run/<run-id>";
      readonly sessionBase: string;
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
  /**
   * The run's session branch: what every issue branch is cut from and merged
   * into. Never the repository's default branch — a run leaves the default
   * branch alone and reaches the user's own branch through one pull request at
   * the end.
   */
  readonly baseBranch: string;
  readonly reviewMode: boolean;
  readonly facts: RepositoryFacts;
}

/**
 * Decides the next step for the current issue. `advance` means this issue is
 * finished; `stop` is terminal for the whole run, never a skip — a failing
 * implementer usually means the issue, or the spec it came from, is wrong, and
 * the issues queued behind it are likely to share that premise.
 *
 * The walk always starts at the first phase and skips every already-satisfied
 * postcondition, so the observed repository — not a persisted phase — decides
 * where the run is. That is what makes resume and normal progress the same code
 * path, and it is why a record that disagrees with the repository loses:
 * a record claiming `merge` on a branch that does not exist re-enters at
 * `branch` rather than stopping on a pull request that was never opened.
 */
export function nextStep(input: ReducerInput): AutoRunStep {
  const { issue, facts, reviewMode } = input;
  // A closed issue is finished work, however it got that way: the run merged its
  // pull request, or the user closed it by hand. Either way there is nothing
  // left to open or merge, so the only remaining step is to tidy up.
  if (facts.issueClosed) return { action: "cleanup", issue };
  for (const phase of AUTO_RUN_PHASES) {
    switch (phase) {
      case "branch":
        if (facts.branchExists && facts.currentBranch === issue.branch) continue;
        // The implementer is told not to touch git, but it has `Bash`. Work left
        // uncommitted somewhere other than the issue's branch is not something to
        // silently correct by checking out over it.
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
        if (facts.pullRequest?.state === "merged") continue;
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
        if (facts.pullRequest?.state === "merged") continue;
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

/**
 * `aboard/<issue-number>-<slug>`. The number is part of the name because
 * slugs collide and because a branch must be greppable back to its issue.
 */
export function branchName(issueNumber: number, title: string): string {
  return `aboard/${issueNumber}-${slugify(title)}`;
}

/**
 * `aboard/run/<run id>` — the branch a whole run merges into, one level below
 * the branch the user was on. Derived from the run id rather than persisted:
 * the record already carries the id, and a stored copy could disagree with it.
 * The `run/` segment keeps it out of the `aboard/<issue>-<slug>` namespace.
 */
export function sessionBranchName(runId: string): string {
  return `aboard/run/${slugify(runId.replace(/^run_/u, ""))}`;
}

const SLUG_MAX_CHARS = 40;

/**
 * Lowercase, every run of non-`[a-z0-9]` collapsed to `-`, trimmed, truncated to
 * 40 characters at a `-` boundary rather than mid-word. An empty result becomes
 * `issue`, so a title of pure punctuation or non-Latin script still names a
 * branch that is legal and readable.
 */
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

/** The commit subject is the issue title, bounded so `git log --oneline` stays readable. */
export const COMMIT_SUBJECT_MAX_CHARS = 72;

export function commitSubject(title: string): string {
  const trimmed = title.trim();
  return trimmed.length <= COMMIT_SUBJECT_MAX_CHARS ? trimmed : `${trimmed.slice(0, COMMIT_SUBJECT_MAX_CHARS - 1).trimEnd()}…`;
}

export const PR_BODY_MAX_CHARS = 4_000;

/**
 * The implementer's final message is already a summary of what it did, so the
 * extension uses it verbatim rather than asking an agent for a second one. The
 * `Closes #N` trailer lives here and not in the commit message: it is what
 * `closingIssuesReferences` reads, which is how a pull request is traced back to
 * its issue.
 *
 * It no longer *closes* anything. GitHub only acts on a closing keyword when the
 * pull request merges into the repository's default branch, and these merge into
 * the run's session branch, so the extension closes the issue itself. The
 * trailer stays for the link, and because the run's own pull request eventually
 * carries the same work to a branch where the keyword may well apply.
 */
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
    ? `aboard auto-run: ${commitSubject(landed[0]!.title)}`
    : `aboard auto-run: ${landed.length} issues`;
}

/**
 * The run's own pull request: an index of what landed on the session branch and
 * where each piece came from. Deliberately carries no closing keyword — every
 * issue listed here is already closed, and a second closing reference on a
 * branch where GitHub *would* honour it only invites reopen/close churn.
 */
export function runPullRequestBody(landed: readonly LandedIssue[], sessionBranch: string, base: string): string {
  const lines = landed.map((issue) => `- #${issue.number} ${commitSubject(issue.title)} (PR #${issue.prNumber})`);
  const body = [
    `Addressed by an aboard auto-run on \`${sessionBranch}\`, one issue at a time.`,
    "",
    ...lines,
    "",
    `Each issue was merged into \`${sessionBranch}\` and closed as it landed; this pull request carries all of it to \`${base}\`.`,
  ].join("\n");
  return body.length <= PR_BODY_MAX_CHARS ? body : `${body.slice(0, PR_BODY_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Why aboard is closing an issue that no merge closed by itself. Worth stating
 * on the issue: a reader who knows GitHub's rule would otherwise wonder what
 * closed it, and the work is not on the user's branch yet.
 */
export function issueClosedComment(prNumber: number, sessionBranch: string, base: string): string {
  return `Merged into \`${sessionBranch}\` by aboard auto-run (#${prNumber}), and closed here because a merge outside the default branch does not close its issue. The work reaches \`${base}\` when the run's pull request merges.`;
}

/**
 * GitHub rejects a comment body over 65536 characters outright, so the bound is
 * the API's and not a judgement about length.
 */
export const ISSUE_COMMENT_MAX_CHARS = 65_536;

/**
 * The implementer's account of its own change, as it is posted on the issue.
 * Verbatim: the agent wrote it for a reader, and an extension that reformats it
 * is guessing at what that reader wants. `undefined` means there is nothing
 * worth posting, which is not a failure — an agent that ended silently has
 * simply said nothing.
 */
export function issueCommentBody(summary: string): string | undefined {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= ISSUE_COMMENT_MAX_CHARS ? trimmed : `${trimmed.slice(0, ISSUE_COMMENT_MAX_CHARS - 1).trimEnd()}…`;
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
  /** Whether the issue has sub-issues of its own, which makes it an umbrella. */
  readonly hasChildren: boolean;
}

/** Notification lines. Kept terse on purpose; they are read in bulk. */
export const autoRunMessage = {
  started: (afk: number, hitl: number, review: boolean, chrome: boolean): string =>
    `auto-run: started — ${afk + hitl} issue${afk + hitl === 1 ? "" : "s"} queued (${afk} afk, ${hitl} hitl), review ${review ? "on" : "off"}, Chrome ${chrome ? "on" : "off"}.`,
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
  runWaiting: (pr: number, base: string): string =>
    `auto-run: PR #${pr} into ${base} is yours to merge (aboard.autoRun.mergeRunPullRequest is off).`,
  runMerged: (pr: number, base: string): string =>
    `auto-run: PR #${pr} merged into ${base}. Pull ${base} to get the work.`,
  runParked: (pr: number, base: string, reason: string): string =>
    `auto-run: PR #${pr} into ${base} needs you (${reason}). The session branch and its pull request are left in place.`,
  runNotOpened: (branch: string, base: string, reason: string): string =>
    `auto-run: the run's work is committed and pushed on ${branch}, but no pull request into ${base} could be opened (${reason}). Open it yourself when you are ready.`,
  reconciled: (issue: number, pr: number, base: string): string =>
    `auto-run: issue #${issue} conflicted with ${base}; merged ${base} into its branch and pushed before retrying PR #${pr}.`,
  parked: (issue: number, pr: number, reason: string): string =>
    `auto-run: issue #${issue} parked — PR #${pr} needs you (${reason}). Its branch, terminals, and pull request are left in place; the run continues with the next issue.`,
  waiting: (issue: number, pr: number): string => `auto-run: issue #${issue} is hitl — PR #${pr} is open and waiting for you. The run is paused.`,
  resolved: (pr: number): string => `auto-run: PR #${pr} merged by you; continuing.`,
  stopped: (issue: number | undefined, reason: string): string =>
    `auto-run: stopped${issue === undefined ? "" : ` at issue #${issue}`} (${reason}). Branch and work left in place.`,
  complete: (count: number, parked: number): string =>
    `auto-run: plan drained (${count} issue${count === 1 ? "" : "s"} addressed${parked === 0 ? "" : `, ${parked} left for you`}). Start another run once more work is labelled.`,
  returned: (branch: string): string => `auto-run: back on ${branch}.`,
} as const;
