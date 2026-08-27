/**
 * The boundary half of recovery validation.
 *
 * It gathers git, GitHub, and filesystem facts about one recorded run and hands
 * them to the pure validator. Nothing here judges: a validator that could reach
 * a process would be a validator nobody can test, and every rule this feeds is
 * in `domain/run-validation.ts` where it can be.
 */

import type { GitClient } from "../git/client.js";
import type { AutoRunRecord } from "../domain/run-plan.js";
import { issueProgress } from "../domain/run-plan.js";
import type {
  BranchObservation,
  IssueObservation,
  PullRequestObservation,
  RunObservations,
} from "../domain/run-validation.js";
import { validateRun } from "../domain/run-validation.js";
import type { RecoveryEligibility } from "../domain/run-plan.js";
import { LABEL_CHROME, hasLabel, issueDifficulty, issueDisposition } from "../shared/labels.js";
import type { AutoRunGitHub } from "./engine.js";

export interface RunObservationSources {
  /** git in the checkout the run works in, which is not always the user's. */
  readonly git: GitClient;
  readonly github: AutoRunGitHub;
  /** Whether the run's own checkout is still there; absent for an in-place run. */
  readonly workspacePresent?: () => Promise<boolean>;
}

/**
 * Reads everything the validator needs, in one pass.
 *
 * The remote refs are fetched and pruned first. Without that, a branch somebody
 * deleted on GitHub still resolves locally and a force-push looks like no change
 * at all — which would make validation confirm exactly the situations it exists
 * to catch.
 */
export async function observeRun(record: AutoRunRecord, sources: RunObservationSources): Promise<RunObservations> {
  const { git, github } = sources;
  let repositoryUsable = true;
  try {
    await git.defaultBranch();
    await git.fetch();
  } catch {
    repositoryUsable = false;
  }
  let gitHubAuthenticated = true;
  try {
    await github.checkAuthentication();
  } catch {
    gitHubAuthenticated = false;
  }

  const workingTree = repositoryUsable
    ? await git.status().then(
        (status) => ({ branch: status.branch, dirtyPaths: status.entries.map((entry) => entry.path) }),
        () => ({ branch: undefined, dirtyPaths: [] as readonly string[] }),
      )
    : { branch: undefined, dirtyPaths: [] as readonly string[] };

  const branchNames = [record.sessionBranch, ...record.plan.map((issue) => issue.branch)];
  const branches: BranchObservation[] = repositoryUsable
    ? await Promise.all([...new Set(branchNames)].map(async (name): Promise<BranchObservation> => ({
        name,
        localSha: await git.branchSha(name).catch(() => undefined),
        remoteSha: await git.remoteBranchSha(name).catch(() => undefined),
      })))
    : [];

  const targetBranchExists = record.targetBranch === undefined || !repositoryUsable
    ? true
    : (await git.branchSha(record.targetBranch).catch(() => undefined)) !== undefined
      || (await git.remoteBranchSha(record.targetBranch).catch(() => undefined)) !== undefined;

  const observed = gitHubAuthenticated ? await observeIssues(record, github) : { issues: [], titles: {} };
  const pullRequests = gitHubAuthenticated ? await observePullRequests(record, github) : [];

  return {
    repositoryUsable,
    gitHubAuthenticated,
    targetBranchExists,
    workspacePresent: sources.workspacePresent === undefined
      ? undefined
      : await sources.workspacePresent().catch(() => false),
    branches,
    issues: observed.issues,
    pullRequests,
    workingTree,
    titles: observed.titles,
  };
}

/**
 * The open-issue scan answers the plan's questions in one call — state, labels,
 * and blockers together. Anything the scan does not list is closed or gone, and
 * only those few need a point lookup.
 */
async function observeIssues(record: AutoRunRecord, github: AutoRunGitHub): Promise<{
  readonly issues: readonly IssueObservation[];
  readonly titles: Readonly<Record<string, string>>;
}> {
  const open = new Map((await github.listImplementableIssues()).candidates.map((candidate) => [candidate.number, candidate]));
  const titles: Record<string, string> = {};
  const issues = await Promise.all(record.plan.map(async (issue): Promise<IssueObservation> => {
    const candidate = open.get(issue.number);
    if (candidate !== undefined) {
      titles[String(issue.number)] = candidate.title;
      return {
        number: issue.number,
        state: "open",
        disposition: issueDisposition(candidate.labels),
        difficulty: issueDifficulty(candidate.labels),
        chrome: hasLabel(candidate.labels, LABEL_CHROME),
        openBlockedByNumbers: candidate.openBlockedByNumbers,
      };
    }
    const snapshot = await github.getIssue(issue.number).catch(() => undefined);
    return {
      number: issue.number,
      state: snapshot === undefined ? "missing" : snapshot.state,
      disposition: snapshot === undefined ? "unclassified" : issueDisposition(snapshot.labels),
      difficulty: snapshot === undefined ? undefined : issueDifficulty(snapshot.labels),
      chrome: snapshot === undefined ? false : hasLabel(snapshot.labels, LABEL_CHROME),
      openBlockedByNumbers: [],
    };
  }));
  return { issues, titles };
}

async function observePullRequests(record: AutoRunRecord, github: AutoRunGitHub): Promise<readonly PullRequestObservation[]> {
  const wanted = new Set<number>();
  for (const issue of record.plan) {
    const progress = issueProgress(record, issue.number);
    if (progress.state === "current" && progress.prNumber !== undefined) wanted.add(progress.prNumber);
    if (progress.state === "done" && progress.result === "landed") wanted.add(progress.prNumber);
  }
  if (record.runPullRequest !== undefined) wanted.add(record.runPullRequest);
  return Promise.all([...wanted].map(async (number): Promise<PullRequestObservation> => {
    const snapshot = await github.getPullRequest(number).catch(() => undefined);
    if (snapshot === undefined) {
      return { number, state: "missing", head: "", base: "", approvedByOther: false };
    }
    // The extension opens every pull request with the user's own credentials and
    // GitHub refuses self-approval, so an `approved` decision can only have come
    // from another account.
    const review = await github.getReviewState(number).catch(() => ({ decision: "unreviewed" as const }));
    return {
      number,
      state: snapshot.state,
      head: snapshot.headBranch,
      base: snapshot.baseBranch,
      approvedByOther: review.decision === "approved",
      ...(snapshot.headSha === undefined ? {} : { headSha: snapshot.headSha }),
      ...(snapshot.mergeCommitSha === undefined ? {} : { mergeCommitSha: snapshot.mergeCommitSha }),
    };
  }));
}

/** Observe, then judge. The one call both the engine and the UI use. */
export async function checkRun(record: AutoRunRecord, sources: RunObservationSources): Promise<{
  readonly eligibility: RecoveryEligibility;
  readonly observations: RunObservations;
}> {
  const observations = await observeRun(record, sources);
  return { eligibility: validateRun(record, observations), observations };
}
