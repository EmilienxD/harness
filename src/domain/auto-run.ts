/**
 * The auto-run phase reducer (`AGENTS.md`).
 *
 * Pure: no `vscode`, no process, no clock, no I/O. Given a run record and the
 * repository facts the engine observed, it returns the next step or the terminal
 * outcome. Every phase is postcondition-checked here rather than in the driver,
 * because resume correctness is exactly "re-enter at the first unsatisfied
 * postcondition" and that decision must be testable without fakes.
 */

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

export const AUTO_RUN_SCOPES = ["spec", "all"] as const;
export type AutoRunScope = (typeof AUTO_RUN_SCOPES)[number];

export const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

export interface AutoRunSettings {
  readonly review: boolean;
  readonly scope: AutoRunScope;
  readonly pauseAfterHitl: boolean;
  readonly mergeStrategy: MergeStrategy;
  readonly pollSeconds: number;
}

export interface PlannedIssue {
  readonly number: number;
  readonly title: string;
  readonly disposition: IssueDisposition;
  readonly branch: string;
}

export interface SkippedIssue {
  readonly number: number;
  readonly reason: string;
}

/**
 * The persisted run record. A resume *hint*, never a source of truth: on
 * resume the engine re-derives every fact from git and GitHub, and a record that
 * disagrees with the repository loses. It carries no prompt text.
 */
export interface AutoRunRecord {
  readonly version: 1;
  readonly runId: string;
  readonly specNumber: number;
  readonly issueNumbers: readonly number[];
  readonly currentIssue: number | undefined;
  readonly phase: AutoRunPhase;
  readonly branch: string | undefined;
  readonly prNumber: number | undefined;
  readonly reviewMode: boolean;
  readonly scope: AutoRunScope;
  /**
   * Issues a pr-doctor has already reviewed. This is the one fact about a run
   * that the repository genuinely cannot answer — a review that found nothing
   * leaves no commit — so it is the one thing the record is authoritative about
   * rather than a hint. Absent or stale, the issue is reviewed again, which is
   * the safe direction to be wrong in.
   */
  readonly reviewedIssues: readonly number[];
  readonly startedAt: string;
}

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
  readonly defaultBranch: string;
  readonly reviewMode: boolean;
  readonly facts: RepositoryFacts;
}

/**
 * Decides the next step for the current issue. `advance` means this issue is
 * finished; `stop` is terminal for the whole run, never a skip — a failing
 * implementer usually means the issue or the spec is wrong, and the siblings
 * share that spec.
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
        return { action: "branch", branch: issue.branch, base: input.defaultBranch };
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
 * `Closes #N` trailer lives here and not in the commit message: PR-based closure
 * is what `closingIssuesReferences` reads and what the merge must trigger.
 */
export function pullRequestBody(summary: string, issueNumber: number): string {
  const trimmed = summary.trim();
  const bounded = trimmed.length <= PR_BODY_MAX_CHARS ? trimmed : `${trimmed.slice(0, PR_BODY_MAX_CHARS - 1).trimEnd()}…`;
  return bounded.length === 0 ? `Closes #${issueNumber}` : `${bounded}\n\nCloses #${issueNumber}`;
}

/** A candidate child issue as GitHub reports it, before selection filters it. */
export interface CandidateIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  readonly openBlockedByNumbers: readonly number[];
}

export interface Selection {
  readonly issues: readonly PlannedIssue[];
  readonly skipped: readonly SkippedIssue[];
}

/**
 * Selection. Unclassified is skipped and reported, never guessed at —
 * `AGENTS.md` is explicit that unclassified is a legitimate third state and that
 * the system flags rather than infers. A blocked issue is deferred rather than
 * failed, because a later merge can unblock it; the engine re-runs this after
 * every merge.
 */
export function selectIssues(candidates: readonly CandidateIssue[]): Selection {
  const issues: PlannedIssue[] = [];
  const skipped: SkippedIssue[] = [];
  for (const candidate of [...candidates].sort((left, right) => left.number - right.number)) {
    if (candidate.state !== "open") continue;
    const disposition = classify(candidate.labels);
    if (disposition === undefined) {
      skipped.push({ number: candidate.number, reason: "unclassified: neither afk nor hitl" });
      continue;
    }
    if (candidate.openBlockedByNumbers.length > 0) {
      skipped.push({
        number: candidate.number,
        reason: `blocked by open ${candidate.openBlockedByNumbers.map((number) => `#${number}`).join(", ")}`,
      });
      continue;
    }
    issues.push({
      number: candidate.number,
      title: candidate.title,
      disposition,
      branch: branchName(candidate.number, candidate.title),
    });
  }
  return { issues, skipped };
}

function classify(labels: readonly string[]): IssueDisposition | undefined {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()));
  // `hitl` wins a contradictory pair: only a human may close it.
  if (normalized.has("hitl")) return "hitl";
  return normalized.has("afk") ? "afk" : undefined;
}

/** Notification lines. Kept terse on purpose; they are read in bulk. */
export const autoRunMessage = {
  started: (spec: number, title: string, afk: number, hitl: number, review: boolean): string =>
    `auto-run: started spec #${spec} "${title}" — ${afk + hitl} issue${afk + hitl === 1 ? "" : "s"} (${afk} afk, ${hitl} hitl), review ${review ? "on" : "off"}.`,
  implemented: (issue: number, branch: string): string => `auto-run: issue #${issue} implemented on ${branch}.`,
  committed: (issue: number, sha: string, pr: number): string => `auto-run: issue #${issue} committed (${sha}) and opened PR #${pr}.`,
  reviewed: (issue: number, paths: readonly string[]): string =>
    `auto-run: issue #${issue} reviewed; committing ${paths.length === 0 ? "no further changes" : `${paths.length} changed path(s): ${paths.slice(0, 10).join(", ")}`}.`,
  captured: (issue: number, pr: number, paths: readonly string[]): string =>
    `auto-run: committed ${paths.length} changed path(s) from issue #${issue}'s open terminals to PR #${pr}: ${paths.slice(0, 10).join(", ")}.`,
  merged: (issue: number): string => `auto-run: issue #${issue} merged, issue closed.`,
  waiting: (issue: number, pr: number): string => `auto-run: issue #${issue} is hitl — PR #${pr} is open and waiting for you. The run is paused.`,
  resolved: (pr: number): string => `auto-run: PR #${pr} merged by you; continuing.`,
  stopped: (issue: number | undefined, reason: string): string =>
    `auto-run: stopped${issue === undefined ? "" : ` at issue #${issue}`} (${reason}). Branch and work left in place.`,
  complete: (spec: number, count: number, remainingSpecs: number): string =>
    `auto-run: spec #${spec} complete (${count} issue${count === 1 ? "" : "s"}). ${remainingSpecs} open spec${remainingSpecs === 1 ? " remains" : "s remain"} — run /auto to continue.`,
} as const;
