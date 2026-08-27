/**
 * What Discard is allowed to remove.
 *
 * Discard always means the same thing to the run record — forget it — and three
 * different things to what the run built. The default is the conservative one:
 * a user who discards a broken run is usually about to go and look at its
 * branches, and a cleanup that ran first would have taken the evidence with it.
 *
 * Every deletion below is guarded by the exact SHA or pull request identity the
 * run recorded. Anything that moved since is left alone and reported, because a
 * branch somebody else pushed to is no longer a branch this run owns.
 */

import { issueProgress, type AutoRunRecord } from "./run-plan.js";
import type { RunObservations } from "./run-validation.js";

export { DISCARD_BEHAVIORS, type DiscardBehavior } from "./auto-run.js";
import type { DiscardBehavior } from "./auto-run.js";

export interface BranchDeletion {
  readonly name: string;
  /** The SHA the run recorded; deletion is refused unless the ref still matches. */
  readonly expectedSha: string;
}

export interface PullRequestClosure {
  readonly number: number;
  readonly head: string;
  readonly base: string;
}

export interface DiscardPlan {
  readonly behavior: DiscardBehavior;
  readonly closeTerminals: boolean;
  /** The run's own checkout, when it created one and it is clean. */
  readonly removeWorkspace: boolean;
  readonly localBranches: readonly BranchDeletion[];
  readonly remoteBranches: readonly BranchDeletion[];
  readonly pullRequests: readonly PullRequestClosure[];
  /** What is deliberately being left in place, and why. Shown before confirming. */
  readonly retained: readonly string[];
}

/**
 * Plans the cleanup for one discard. Pure, so the modal summary the user
 * confirms and the work the boundary performs are the same list rather than two
 * descriptions that can drift apart.
 */
export function planDiscard(
  record: AutoRunRecord,
  behavior: DiscardBehavior,
  observations: RunObservations,
): DiscardPlan {
  const retained: string[] = [];
  if (behavior === "record-only") {
    return {
      behavior,
      closeTerminals: false,
      removeWorkspace: false,
      localBranches: [],
      remoteBranches: [],
      pullRequests: [],
      retained: ["terminals, branches, commits, pull requests, and issues are all left as they are"],
    };
  }

  const workspaceDirty = observations.workingTree.dirtyPaths.length > 0;
  const removeWorkspace = record.workspaceCreated === true && observations.workspacePresent === true && !workspaceDirty;
  if (record.workspaceCreated === true && workspaceDirty) {
    retained.push("the run's checkout has uncommitted changes and is kept");
  }

  const localBranches: BranchDeletion[] = [];
  const remoteBranches: BranchDeletion[] = [];
  for (const name of ownedBranches(record)) {
    const expectedSha = record.branchShas[name];
    // No recorded SHA means the run never proved it created this branch. Ownership
    // is never guessed at from a name.
    if (expectedSha === undefined) continue;
    if (isLanded(record, name)) {
      retained.push(`${name} carries work that already merged and is kept`);
      continue;
    }
    const observed = observations.branches.find((branch) => branch.name === name);
    if (observed?.localSha === expectedSha) localBranches.push({ name, expectedSha });
    else if (observed?.localSha !== undefined) retained.push(`${name} has moved since the run pushed it and is kept`);
    if (behavior !== "full-cleanup") continue;
    if (observed?.remoteSha === expectedSha) remoteBranches.push({ name, expectedSha });
    else if (observed?.remoteSha !== undefined) retained.push(`origin/${name} has moved since the run pushed it and is kept`);
  }

  const pullRequests: PullRequestClosure[] = [];
  if (behavior === "full-cleanup") {
    for (const candidate of ownedPullRequests(record)) {
      const observed = observations.pullRequests.find((pullRequest) => pullRequest.number === candidate.number);
      if (observed === undefined || observed.state === "missing") continue;
      if (observed.state === "merged") { retained.push(`pull request #${candidate.number} is merged and is left alone`); continue; }
      if (observed.state === "closed") continue;
      if (observed.head !== candidate.head || observed.base !== candidate.base) {
        retained.push(`pull request #${candidate.number} was retargeted and is kept`);
        continue;
      }
      pullRequests.push(candidate);
    }
  }

  retained.push("issues the run closed stay closed, and merged commits are never reverted");
  return { behavior, closeTerminals: true, removeWorkspace, localBranches, remoteBranches, pullRequests, retained };
}

/** Branches this run created, whether or not it still expects them to exist. */
function ownedBranches(record: AutoRunRecord): readonly string[] {
  return [record.sessionBranch, ...record.plan.map((issue) => issue.branch)];
}

/** Whether a branch's work already reached the session branch, or is the session branch after its own merge. */
function isLanded(record: AutoRunRecord, branch: string): boolean {
  if (branch === record.sessionBranch) return record.checkpoint === "complete";
  const issue = record.plan.find((entry) => entry.branch === branch);
  if (issue === undefined) return false;
  const progress = issueProgress(record, issue.number);
  return progress.state === "done" && progress.result === "landed";
}

function ownedPullRequests(record: AutoRunRecord): readonly PullRequestClosure[] {
  const closures: PullRequestClosure[] = [];
  for (const issue of record.plan) {
    const progress = issueProgress(record, issue.number);
    if (progress.state !== "current" || progress.prNumber === undefined) continue;
    closures.push({ number: progress.prNumber, head: issue.branch, base: record.sessionBranch });
  }
  if (record.runPullRequest !== undefined && record.targetBranch !== undefined) {
    closures.push({ number: record.runPullRequest, head: record.sessionBranch, base: record.targetBranch });
  }
  return closures;
}

/** What actually happened, so leftovers can be listed without failing the discard. */
export interface DiscardResult {
  readonly behavior: DiscardBehavior;
  readonly deletedLocalBranches: readonly string[];
  readonly deletedRemoteBranches: readonly string[];
  readonly closedPullRequests: readonly number[];
  readonly workspaceRemoved: boolean;
  /** Everything that could not be cleaned up, phrased for the user. */
  readonly leftovers: readonly string[];
}

/** The modal summary, built from the same plan the boundary will execute. */
export function describeDiscard(plan: DiscardPlan): string {
  const lines: string[] = [];
  if (plan.closeTerminals) lines.push("Close this run's terminals.");
  if (plan.removeWorkspace) lines.push("Remove the run's own checkout.");
  if (plan.localBranches.length > 0) lines.push(`Delete ${plan.localBranches.length} local branch(es): ${plan.localBranches.map((branch) => branch.name).join(", ")}.`);
  if (plan.remoteBranches.length > 0) lines.push(`Delete ${plan.remoteBranches.length} remote branch(es): ${plan.remoteBranches.map((branch) => branch.name).join(", ")}.`);
  if (plan.pullRequests.length > 0) lines.push(`Close pull request(s) ${plan.pullRequests.map((pullRequest) => `#${pullRequest.number}`).join(", ")}.`);
  if (lines.length === 0) lines.push("Forget the run record only.");
  for (const note of plan.retained) lines.push(`Kept: ${note}.`);
  return lines.join("\n");
}
