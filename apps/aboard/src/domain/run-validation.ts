
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
  readonly chrome: boolean;
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
  readonly workspacePresent: boolean | undefined;
  readonly branches: readonly BranchObservation[];
  readonly issues: readonly IssueObservation[];
  readonly pullRequests: readonly PullRequestObservation[];
  readonly workingTree: {
    readonly branch: string | undefined;
    readonly dirtyPaths: readonly string[];
  };
  readonly titles: Readonly<Record<string, string>>;
}

function broken(reason: string): RecoveryEligibility {
  return { state: "broken", reason };
}

const RESUMABLE: RecoveryEligibility = { state: "resumable" };

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

function validateBranches(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility | undefined {
  const required = new Set<string>();
  if (record.checkpoint !== "planned" && record.checkpoint !== "workspace-ready") required.add(record.sessionBranch);
  const current = record.currentIssue === undefined ? undefined : record.plan.find((issue) => issue.number === record.currentIssue);
  if (current !== undefined && record.settings.branchMode !== "single-branch") {
    const progress = issueProgress(record, current.number);
    // The branch is required only once the run recorded a SHA for it: before
    // the branch phase reaches its postcondition there is nothing to require.
    if (progress.state === "current" && record.branchShas[current.branch] !== undefined) required.add(current.branch);
  }

  for (const name of required) {
    const observed = branchOf(observations, name);
    const expected = record.branchShas[name];
    const merge = mergePostcondition(record.pendingAction, name, observations)
      ?? hitlMergePostcondition(record, name, observations);
    // A journalled worker owns exactly one commit on its branch. Its ancestry
    // and count are checked where the worker settles, not from a bare SHA here.
    const workerRunning = record.pendingAction?.kind === "worker-commit" && record.pendingAction.branch === name;
    if (observed?.localSha === undefined && observed?.remoteSha === undefined) {
      const mergedHeadWasDeleted = record.pendingAction?.kind === "merge-issue-pr"
        && record.pendingAction.head === name
        && mergePostcondition(record.pendingAction, record.pendingAction.base, observations) !== undefined;
      if (mergedHeadWasDeleted) continue;
      return broken(`the run's branch ${name} no longer exists`);
    }
    if (expected === undefined || workerRunning) continue;
    if (observed.localSha !== undefined && observed.localSha !== expected && merge?.mergeCommitSha !== observed.localSha) {
      return broken(`${name} has moved since the run last pushed it`);
    }
    if (observed.remoteSha !== undefined && observed.remoteSha !== expected && merge?.mergeCommitSha !== observed.remoteSha) {
      return broken(`origin/${name} has moved since the run last pushed it`);
    }
  }

  for (const issue of record.plan) {
    if (record.settings.branchMode === "single-branch") break;
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

/**
 * A user merging the current HITL pull request is the one unjournalled change
 * allowed to move the session branch. Keep the exception as exact as a
 * journalled merge: the recorded issue head must be what GitHub merged, and
 * the observed branch movement must stop at GitHub's merge commit.
 */
function hitlMergePostcondition(
  record: AutoRunRecord,
  branch: string,
  observations: RunObservations,
): PullRequestObservation | undefined {
  if (branch !== record.sessionBranch) return undefined;
  const issue = currentIssue(record);
  if (issue?.disposition !== "hitl") return undefined;
  const progress = issueProgress(record, issue.number);
  if (progress.state !== "current" || progress.prNumber === undefined) return undefined;
  const expectedHead = record.branchShas[issue.branch];
  if (expectedHead === undefined) return undefined;
  const pullRequest = pullRequestOf(observations, progress.prNumber);
  if (pullRequest?.state !== "merged" || pullRequest.head !== issue.branch || pullRequest.base !== branch) return undefined;
  if (pullRequest.headSha !== expectedHead || pullRequest.mergeCommitSha === undefined) return undefined;
  const baseBranch = branchOf(observations, branch);
  if (baseBranch?.localSha !== pullRequest.mergeCommitSha && baseBranch?.remoteSha !== pullRequest.mergeCommitSha) return undefined;
  return pullRequest;
}

function issueOf(observations: RunObservations, number: number): IssueObservation | undefined {
  return observations.issues.find((issue) => issue.number === number);
}

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
    if (observed.chrome !== (issue.chrome === true)) {
      return broken(`issue #${issue.number} ${observed.chrome ? "now has" : "no longer has"} the [AI]-chrome label`);
    }
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

function validatePullRequests(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility | undefined {
  if (record.settings.branchMode === "single-branch") {
    if (record.runPullRequest === undefined) return undefined;
    const observed = pullRequestOf(observations, record.runPullRequest);
    const identity = validatePullRequestIdentity(observed, record.runPullRequest, record.sessionBranch, record.targetBranch);
    if (identity !== undefined) return identity;
    if (observed!.state === "closed") return broken(`the run's pull request #${record.runPullRequest} was closed`);
    if (observed!.state === "merged" && remainingIssuesForValidation(record) && !journalMerges(record.pendingAction, observed!)) return broken(`the run's pull request #${record.runPullRequest} merged while its issue queue was active`);
    return undefined;
  }
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

function validateWorkingTree(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility {
  if (observations.workingTree.dirtyPaths.length === 0) return RESUMABLE;
  const current = currentIssue(record);
  const branch = observations.workingTree.branch;
  const expected = record.settings.branchMode === "single-branch" ? record.sessionBranch : current?.branch;
  if (current !== undefined && branch === expected) return RESUMABLE;
  return broken(
    `there are uncommitted changes on ${branch ?? "a detached HEAD"}, which is not the branch this run is working`,
  );
}

export function currentIssue(record: AutoRunRecord): FrozenIssue | undefined {
  if (record.currentIssue === undefined) return undefined;
  return record.plan.find((issue) => issue.number === record.currentIssue);
}

function remainingIssuesForValidation(record: AutoRunRecord): boolean {
  return record.plan.some((issue) => issueProgress(record, issue.number).state !== "done");
}
