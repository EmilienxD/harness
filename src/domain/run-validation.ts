/**
 * Recovery validation (`AGENTS.md`).
 *
 * One pure function decides whether a recorded run may continue. The boundary
 * gathers observations; every judgement lives here, so "is this run still the
 * run the user agreed to?" is answerable in a unit test without a repository.
 *
 * The bias is deliberate and one-directional: anything that cannot be explained
 * by aboard's own recorded actions makes the whole run broken. A run that stops
 * because somebody force-pushed a branch costs the user a resume; a run that
 * continues over an unexplained change costs them work they never approved.
 */

import type { IssueDifficulty } from "../shared/labels.js";
import type { IssueDisposition } from "./auto-run.js";
import {
  issueProgress,
  type AutoRunRecord,
  type FrozenIssue,
  type PendingAction,
  type RecoveryEligibility,
} from "./run-plan.js";

export interface BranchObservation {
  readonly name: string;
  /** Full SHA of the local ref, or `undefined` when it does not exist. */
  readonly localSha: string | undefined;
  /** Full SHA of `origin/<name>` after a prune-ing fetch, or `undefined`. */
  readonly remoteSha: string | undefined;
}

export interface IssueObservation {
  readonly number: number;
  readonly state: "open" | "closed" | "missing";
  readonly disposition: IssueDisposition | "unclassified";
  readonly difficulty: IssueDifficulty | undefined;
  /** Open blockers as GitHub reports them now. */
  readonly openBlockedByNumbers: readonly number[];
}

export interface PullRequestObservation {
  readonly number: number;
  readonly state: "open" | "closed" | "merged" | "missing";
  readonly head: string;
  readonly base: string;
  /** An approval from an account other than the one that opened it. */
  readonly approvedByOther: boolean;
  readonly headSha?: string;
  readonly mergeCommitSha?: string;
}

/** Everything the boundary gathered for one validation pass. */
export interface RunObservations {
  readonly repositoryUsable: boolean;
  readonly gitHubAuthenticated: boolean;
  readonly targetBranchExists: boolean;
  /**
   * Whether the run's own checkout is present. `undefined` when the run works
   * in the user's checkout, where there is nothing of the kind to lose.
   */
  readonly workspacePresent: boolean | undefined;
  readonly branches: readonly BranchObservation[];
  readonly issues: readonly IssueObservation[];
  readonly pullRequests: readonly PullRequestObservation[];
  readonly workingTree: {
    readonly branch: string | undefined;
    readonly dirtyPaths: readonly string[];
  };
  /**
   * Issue titles as GitHub reports them now, keyed by issue number. Displayed
   * only: the plan froze the title it uses for branches and commits, and a
   * retitled issue is still the same work.
   */
  readonly titles: Readonly<Record<string, string>>;
}

function broken(reason: string): RecoveryEligibility {
  return { state: "broken", reason };
}

const RESUMABLE: RecoveryEligibility = { state: "resumable" };

/**
 * Validates the complete frozen plan, including issues the run has not reached
 * yet. Checking only the current issue would let a run walk into a plan entry
 * that was relabelled or closed hours ago and discover it one dead worker at a
 * time.
 */
export function validateRun(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility {
  if (!observations.repositoryUsable) return broken("the workspace is no longer a usable git repository");
  if (!observations.gitHubAuthenticated) return broken("the GitHub CLI can no longer authenticate to this repository");

  const workspace = validateWorkspace(record, observations);
  if (workspace !== undefined) return workspace;

  const target = record.targetBranch;
  // The user's own branch may advance freely; the run's final pull request
  // already owns reconciling with whatever landed there.
  if (target !== undefined && !observations.targetBranchExists) {
    return broken(`the branch this run started from (${target}) no longer exists`);
  }

  const branches = validateBranches(record, observations);
  if (branches !== undefined) return branches;

  const issues = validateIssues(record, observations);
  if (issues !== undefined) return issues;

  const pullRequests = validatePullRequests(record, observations);
  if (pullRequests !== undefined) return pullRequests;

  return validateWorkingTree(record, observations);
}

/**
 * A checkout the run created must still be there. Before that checkpoint there
 * is nothing to have lost, so a run that died while preparing one simply retries
 * — which is why this asks about `workspaceCreated` and not about the setting.
 */
function validateWorkspace(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility | undefined {
  if (record.workspaceCreated !== true) return undefined;
  if (observations.workspacePresent === false) {
    return broken("the run's own checkout is gone");
  }
  return undefined;
}

function branchOf(observations: RunObservations, name: string): BranchObservation | undefined {
  return observations.branches.find((branch) => branch.name === name);
}

/**
 * Run-owned branches must be exactly where this run left them. A branch the run
 * pushed and something else moved — a force-push, an extra commit, a deletion —
 * is the clearest possible signal that the run's record no longer describes
 * reality, and it is also the case where continuing would quietly build on
 * somebody else's work.
 */
function validateBranches(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility | undefined {
  const required = new Set<string>();
  if (record.checkpoint !== "planned" && record.checkpoint !== "workspace-ready") required.add(record.sessionBranch);
  const current = record.currentIssue === undefined ? undefined : record.plan.find((issue) => issue.number === record.currentIssue);
  if (current !== undefined) {
    const progress = issueProgress(record, current.number);
    // The branch is required only once the run recorded a SHA for it: before
    // the branch phase reaches its postcondition there is nothing to require.
    if (progress.state === "current" && record.branchShas[current.branch] !== undefined) required.add(current.branch);
  }

  for (const name of required) {
    const observed = branchOf(observations, name);
    const expected = record.branchShas[name];
    const merge = mergePostcondition(record.pendingAction, name, observations);
    if (observed?.localSha === undefined && observed?.remoteSha === undefined) {
      return broken(`the run's branch ${name} no longer exists`);
    }
    if (expected === undefined) continue;
    if (observed.localSha !== undefined && observed.localSha !== expected && merge?.mergeCommitSha !== observed.localSha) {
      return broken(`${name} has moved since the run last pushed it`);
    }
    if (observed.remoteSha !== undefined && observed.remoteSha !== expected && merge?.mergeCommitSha !== observed.remoteSha) {
      return broken(`origin/${name} has moved since the run last pushed it`);
    }
  }

  // A branch belonging to a plan entry the run has not started is a branch this
  // run did not create. Adopting it would mean committing onto somebody else's
  // work under this issue's name.
  for (const issue of record.plan) {
    if (required.has(issue.branch)) continue;
    if (issueProgress(record, issue.number).state !== "pending") continue;
    const observed = branchOf(observations, issue.branch);
    if (observed?.localSha !== undefined || observed?.remoteSha !== undefined) {
      return broken(`${issue.branch} already exists but this run did not create it`);
    }
  }
  return undefined;
}

function mergePostcondition(
  action: PendingAction | undefined,
  branch: string,
  observations: RunObservations,
): PullRequestObservation | undefined {
  if ((action?.kind !== "merge-issue-pr" && action?.kind !== "merge-run-pr") || action.base !== branch) return undefined;
  const pullRequest = pullRequestOf(observations, action.prNumber);
  if (pullRequest?.state !== "merged" || pullRequest.head !== action.head || pullRequest.base !== action.base) return undefined;
  if (pullRequest.headSha !== action.headSha || pullRequest.mergeCommitSha === undefined) return undefined;
  const baseBranch = branchOf(observations, branch);
  if (baseBranch?.localSha !== pullRequest.mergeCommitSha && baseBranch?.remoteSha !== pullRequest.mergeCommitSha) return undefined;
  return pullRequest;
}

function issueOf(observations: RunObservations, number: number): IssueObservation | undefined {
  return observations.issues.find((issue) => issue.number === number);
}

/**
 * The plan's issues must still be the issues the plan describes. Title and body
 * are deliberately not compared: the run froze the title it needs for branches
 * and commits, and an issue somebody clarified in prose is still the same work.
 */
function validateIssues(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility | undefined {
  const planned = new Set(record.plan.map((issue) => issue.number));
  for (const issue of record.plan) {
    const progress = issueProgress(record, issue.number);
    const observed = issueOf(observations, issue.number);
    if (observed === undefined || observed.state === "missing") {
      return broken(`issue #${issue.number} no longer exists`);
    }
    if (progress.state === "done") {
      // Only what aboard itself recorded is required. A close that failed was
      // reported to the user and survived; either state is legitimate now.
      if (progress.result === "landed" && progress.issueClosed && observed.state === "open") {
        return broken(`issue #${issue.number} was reopened after the run closed it`);
      }
      continue;
    }
    if (observed.state === "closed") {
      return broken(`issue #${issue.number} was closed while the run still had it queued`);
    }
    if (observed.disposition !== issue.disposition) {
      return broken(`issue #${issue.number} is now ${describeDisposition(observed.disposition)} rather than ${issue.disposition}`);
    }
    if (observed.difficulty !== issue.difficulty) {
      return broken(`issue #${issue.number} has a different difficulty than when the run planned it`);
    }
    // Blockers may close as the run drains its plan, so the observed set only
    // has to be contained in the frozen one. A blocker that appeared is new
    // work the plan never accounted for.
    const frozen = new Set(issue.dependsOn);
    for (const blocker of observed.openBlockedByNumbers) {
      if (!frozen.has(blocker)) {
        return broken(`issue #${issue.number} is now blocked by #${blocker}, which the run did not plan for`);
      }
      if (!planned.has(blocker)) {
        return broken(`issue #${issue.number} depends on #${blocker}, which is outside this run`);
      }
    }
    for (const blocker of issue.dependsOn) {
      const blockerObservation = issueOf(observations, blocker);
      if (blockerObservation?.state === "open" && !observed.openBlockedByNumbers.includes(blocker)) {
        return broken(`issue #${issue.number} is no longer blocked by #${blocker} as the run planned`);
      }
    }
  }
  return undefined;
}

function describeDisposition(disposition: IssueDisposition | "unclassified"): string {
  return disposition === "unclassified" ? "unclassified" : disposition;
}

function pullRequestOf(observations: RunObservations, number: number): PullRequestObservation | undefined {
  return observations.pullRequests.find((pullRequest) => pullRequest.number === number);
}

function journalMerges(action: PendingAction | undefined, pullRequest: PullRequestObservation): boolean {
  return (action?.kind === "merge-issue-pr" || action?.kind === "merge-run-pr")
    && action.prNumber === pullRequest.number
    && action.head === pullRequest.head
    && action.base === pullRequest.base
    && action.headSha === pullRequest.headSha
    && pullRequest.mergeCommitSha !== undefined;
}

/**
 * Every pull request the record knows about must still be the pull request it
 * recorded, and in a state this checkpoint can explain.
 *
 * Two external transitions are allowed, because they are the whole point of the
 * hitl disposition: another account approving, and the user merging. Everything
 * else — an afk pull request merged by somebody else, a closed one, a retargeted
 * one — means the run's next step would act on something it no longer describes.
 */
function validatePullRequests(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility | undefined {
  for (const issue of record.plan) {
    const progress = issueProgress(record, issue.number);
    const prNumber = progress.state === "current" ? progress.prNumber
      : progress.state === "done" && progress.result === "landed" ? progress.prNumber
        : undefined;
    if (prNumber === undefined) continue;
    const observed = pullRequestOf(observations, prNumber);
    const identity = validatePullRequestIdentity(observed, prNumber, issue.branch, record.sessionBranch);
    if (identity !== undefined) return identity;

    if (progress.state === "done") {
      if (observed!.state !== "merged") {
        return broken(`pull request #${prNumber} for issue #${issue.number} is no longer merged`);
      }
      continue;
    }
    if (observed!.state === "closed") {
      return broken(`pull request #${prNumber} for issue #${issue.number} was closed without merging`);
    }
    if (observed!.state === "merged" && !journalMerges(record.pendingAction, observed!) && issue.disposition !== "hitl") {
      return broken(`pull request #${prNumber} for issue #${issue.number} was merged outside the run`);
    }
  }

  if (record.runPullRequest !== undefined) {
    const observed = pullRequestOf(observations, record.runPullRequest);
    const target = record.targetBranch;
    const identity = validatePullRequestIdentity(observed, record.runPullRequest, record.sessionBranch, target);
    if (identity !== undefined) return identity;
    if (observed!.state === "closed") return broken(`the run's pull request #${record.runPullRequest} was closed`);
    if (observed!.state === "merged" && !journalMerges(record.pendingAction, observed!)) {
      return broken(`the run's pull request #${record.runPullRequest} was merged outside the run`);
    }
  }
  return undefined;
}

function validatePullRequestIdentity(
  observed: PullRequestObservation | undefined,
  prNumber: number,
  head: string,
  base: string | undefined,
): RecoveryEligibility | undefined {
  if (observed === undefined || observed.state === "missing") return broken(`pull request #${prNumber} no longer exists`);
  if (observed.head !== head) return broken(`pull request #${prNumber} no longer comes from ${head}`);
  if (base !== undefined && observed.base !== base) return broken(`pull request #${prNumber} no longer targets ${base}`);
  return undefined;
}

/**
 * Uncommitted work is trusted on exactly one branch: the one the current issue
 * belongs to. That is where a failed or interrupted worker leaves its edits, and
 * a fresh worker will be told to review them critically before the run commits
 * anything. Anywhere else it is somebody's work the run has no claim on, and the
 * run stages with `git add -A`.
 */
function validateWorkingTree(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility {
  if (observations.workingTree.dirtyPaths.length === 0) return RESUMABLE;
  const current = currentIssue(record);
  const branch = observations.workingTree.branch;
  if (current !== undefined && branch === current.branch) return RESUMABLE;
  return broken(
    `there are uncommitted changes on ${branch ?? "a detached HEAD"}, which is not the branch this run is working`,
  );
}

export function currentIssue(record: AutoRunRecord): FrozenIssue | undefined {
  if (record.currentIssue === undefined) return undefined;
  return record.plan.find((issue) => issue.number === record.currentIssue);
}

/**
 * Whether uncommitted work in the checkout belongs to the run's current issue.
 * The engine asks this to decide whether a fresh worker needs the one extra
 * sentence warning it about half-finished edits.
 */
export function hasTrustedDirtyWork(record: AutoRunRecord, observations: RunObservations): boolean {
  const current = currentIssue(record);
  if (current === undefined || observations.workingTree.dirtyPaths.length === 0) return false;
  return observations.workingTree.branch === current.branch;
}

/**
 * The one sentence added to an otherwise normal worker prompt when the run is
 * re-entering an issue that already has uncommitted edits. Exactly one, because
 * a recovery prompt that explains the whole crash invites the agent to
 * investigate the crash rather than finish the issue.
 */
export const DIRTY_RECOVERY_SENTENCE =
  "Existing uncommitted changes may be incomplete or incorrect; review them critically before finishing the issue.";
