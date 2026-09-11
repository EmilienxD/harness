
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

export async function observeRun(record: AutoRunRecord, sources: RunObservationSources): Promise<RunObservations> {
  const { git, github } = sources;
  let repositoryUsable = true;
  let status;
  try {
    status = await git.status();
  } catch {
    repositoryUsable = false;
  }
  // Fetch is a remote observation, not proof that the local checkout is a
  // repository. Let an unavailable remote fail the check operationally instead
  // of turning a retryable network or ref-lock error into structural damage.
  if (repositoryUsable) await git.fetch();
  let gitHubAuthenticated = true;
  try {
    await github.checkAuthentication();
  } catch {
    gitHubAuthenticated = false;
  }

  const workingTree = repositoryUsable && status !== undefined
    ? { branch: status.branch, dirtyPaths: status.entries.map((entry) => entry.path) }
    : { branch: undefined, dirtyPaths: [] as readonly string[] };

  const branchNames = record.settings.branchMode === "single-branch" ? [record.sessionBranch] : [record.sessionBranch, ...record.plan.map((issue) => issue.branch)];
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

  const progress = record.currentIssue === undefined ? undefined : issueProgress(record, record.currentIssue);
  const startingSha = record.pendingAction?.kind === "worker-commit" ? record.pendingAction.parentSha
    : progress?.state === "current" ? progress.beforeSha : undefined;
  const headSha = repositoryUsable && startingSha !== undefined ? await git.headSha(false) : undefined;
  const descendsFromStart = startingSha !== undefined && headSha !== undefined && (startingSha === headSha || await git.isAncestor(startingSha, headSha));
  const issueRange = startingSha === undefined || headSha === undefined ? undefined : {
    startingSha, headSha, dirtyPaths: workingTree.dirtyPaths, descendsFromStart,
    newCommitCount: descendsFromStart ? (await git.aheadBehind(headSha, startingSha)).ahead : 0,
  };
  return {
    ...(issueRange === undefined ? {} : { issueRange }),
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
    if (record.settings.branchMode !== "single-branch" && progress.state === "current" && progress.prNumber !== undefined) wanted.add(progress.prNumber);
    if (record.settings.branchMode !== "single-branch" && progress.state === "done" && progress.result === "landed") wanted.add(progress.prNumber);
  }
  if (record.runPullRequest !== undefined) wanted.add(record.runPullRequest);
  return Promise.all([...wanted].map(async (number): Promise<PullRequestObservation> => {
    const snapshot = await github.getPullRequest(number).catch(() => undefined);
    if (snapshot === undefined) {
      return { number, state: "missing", head: "", base: "" };
    }
    return {
      number,
      state: snapshot.state,
      head: snapshot.headBranch,
      base: snapshot.baseBranch,
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
