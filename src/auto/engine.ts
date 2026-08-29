/**
 * The auto-run driver (`AGENTS.md`).
 *
 * The extension owns the loop; agents only produce content. Every git and GitHub
 * side effect below is performed here, never by an agent, so a branch name, a
 * commit message, a PR title and its `Closes #N` trailer are correct by
 * construction and recoverable after a crash.
 *
 * Two invariants shape everything here. The plan is fixed: it is discovered once
 * at start and never rediscovered, so a run works exactly the issues the user
 * agreed to. And every mutation is write-ahead journalled and postcondition
 * checked, so resume re-enters at the first unsatisfied checkpoint rather than
 * repeating work — while a repository that changed in a way the record cannot
 * explain stops the whole run instead of quietly continuing.
 */

import { existsSync } from "node:fs";

import {
  autoRunMessage,
  commitSubject,
  issueClosedComment,
  issueCommentBody,
  nextStep,
  pullRequestBody,
  runPullRequestBody,
  runPullRequestTitle,
  sessionBranchName,
  type AutoRunDryRunResult,
  type AutoRunPhase,
  type AutoRunSettings,
  type CandidateIssue,
  type RepositoryFacts,
  type SkippedIssue,
} from "../domain/auto-run.js";
import {
  completedCount,
  issueProgress,
  landedIssues,
  planRun,
  remainingIssues,
  runSucceeded,
  withProgress,
  type AutoRunRecord,
  type FrozenIssue,
  type FrozenRunSettings,
  type IssueProgress,
  type PendingAction,
  type PersistedAutoRunRecord,
  type RecoveryEligibility,
  type RunAttemptOutcome,
  type RunCheckpoint,
} from "../domain/run-plan.js";
import { isUnsupportedRecord, UNSUPPORTED_RECORD_REASON } from "../domain/run-plan.js";
import { DIRTY_RECOVERY_SENTENCE, hasTrustedDirtyWork, validateRun, type RunObservations } from "../domain/run-validation.js";
import { planDiscard, type DiscardBehavior, type DiscardPlan, type DiscardResult } from "../domain/run-cleanup.js";
import type { AgentId, SessionId, TerminalId } from "../domain/contracts.js";
import type { LaunchOrigin } from "../domain/lease.js";
import type { GitClient, GitStatus } from "../git/client.js";
import type { AutomatedLaunchOutcome, DelegationLaunchInput, InteractiveLaunchHandles, LaunchIsolation } from "../bridge/delegation.js";
import { runWorkspacePath, type RunWorkspace, type RunWorkspaceOutcome, type RunWorkspaceProvider } from "./worktree.js";
import { checkRun, type RunObservationSources } from "./observation.js";
import type { IssueDifficulty } from "../shared/labels.js";

/**
 * A pull request as the run observes it. `mergeable` is carried because a merge
 * that fails has many causes and only one of them — a conflict — is something
 * the run can act on rather than surrender to.
 */
export interface PullRequestObservation {
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha?: string;
  readonly mergeCommitSha?: string;
}

/** The GitHub surface the engine needs, narrowed so tests can fake it whole. */
export interface AutoRunGitHub {
  /** Proves that gh can authenticate to and resolve the workspace repository. */
  checkAuthentication(): Promise<void>;
  /**
   * Every open issue and its inferred dependencies. Read once to plan a run, and
   * afterwards only to observe the plan's own issues.
   */
  listImplementableIssues(): Promise<{ readonly candidates: readonly CandidateIssue[] }>;
  getIssue(number: number): Promise<{ readonly state: "open" | "closed"; readonly labels: readonly string[] } | undefined>;
  addIssueComment(number: number, body: string): Promise<void>;
  closeIssue(number: number, comment: string): Promise<void>;
  createPullRequest(input: { readonly title: string; readonly body: string; readonly head: string; readonly base: string }): Promise<number>;
  findOpenPullRequestForBranch(branch: string): Promise<number | undefined>;
  findPullRequestForBranch(branch: string): Promise<number | undefined>;
  getPullRequest(number: number): Promise<PullRequestObservation | undefined>;
  getReviewState(number: number): Promise<{ readonly decision: "approved" | "changes-requested" | "reviewed" | "unreviewed" }>;
  mergePullRequest(number: number, strategy: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void>;
  /** Closes an open pull request, but only while its head and base still match. */
  closePullRequestIf(number: number, expected: { readonly head: string; readonly base: string }): Promise<boolean>;
}

export interface AutoRunLauncher {
  runAutomated(input: DelegationLaunchInput, signal?: AbortSignal): Promise<AutomatedLaunchOutcome>;
  launchInteractive(input: DelegationLaunchInput, origin: LaunchOrigin): Promise<InteractiveLaunchHandles>;
}

export interface AutoRunTerminals {
  close(terminalId: TerminalId): void;
}

export interface AutoRunStore {
  load(): Promise<PersistedAutoRunRecord | undefined>;
  save(record: PersistedAutoRunRecord): Promise<void>;
  clear(): Promise<void>;
}

/** One bounded line per phase transition, drained on the user's next message. */
export interface AutoRunNotifier {
  notify(message: string): void;
  /**
   * Something is waiting on the user's hands. Queued progress reaches whoever
   * next talks to the Manager, which is the wrong channel for a run that has
   * stopped: the user may not be talking to the Manager at all.
   */
  alert(message: string, pullRequestUrl?: string): void;
}

/** How the run's own history is recorded, so the panel can show it. */
export interface AutoRunActivitySink {
  runStarted(record: AutoRunRecord, resumed: boolean): void;
  runEnded(record: AutoRunRecord, outcome: RunAttemptOutcome | "succeeded"): void;
  runDiscarded(record: PersistedAutoRunRecord): void;
}

/** Who owns an open pull request, so `review_pr` can reopen that session. */
export interface PullRequestOwner {
  readonly prNumber: number;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: TerminalId;
  readonly type: "implementer" | "pr-doctor-afk" | "pr-doctor-hitl";
  readonly issueNumber: number;
  readonly difficulty?: IssueDifficulty;
  /** Where the session ran, when the run had a checkout of its own. */
  readonly cwd?: string;
}

export interface AutoRunEngineOptions {
  /** git in the user's own checkout. */
  readonly git: GitClient;
  /** Creates a git boundary rooted in a recorded isolated checkout. */
  readonly gitFor?: (cwd: string) => GitClient;
  readonly workspaceRoot: string;
  /** Where this run works. Absent means the workspace itself. */
  readonly workspaces?: RunWorkspaceProvider;
  readonly github: AutoRunGitHub;
  readonly launcher: AutoRunLauncher;
  readonly terminals: AutoRunTerminals;
  readonly store: AutoRunStore;
  readonly notifier: AutoRunNotifier;
  readonly activity?: AutoRunActivitySink;
  readonly settings: () => AutoRunSettings;
  readonly discardBehavior?: () => DiscardBehavior;
  readonly log?: (message: string) => void;
  readonly onStateChange?: (state: AutoRunState | undefined) => void;
  /** Fired whenever the persisted record or its recovery eligibility changes. */
  readonly onRecordChange?: () => void;
  readonly now?: () => Date;
  readonly runIdFactory?: () => string;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly pathExists?: (path: string) => boolean;
}

export interface AutoRunState {
  readonly runId: string;
  readonly phase: AutoRunPhase;
  readonly currentIssue: number | undefined;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly waiting: boolean;
  readonly currentPullRequest: number | undefined;
}

export type AutoRunStartResult =
  | {
      readonly started: true;
      readonly runId: string;
      readonly reviewMode: boolean;
      readonly sessionBranch: string;
      readonly sessionBase: string;
      readonly mergesItsOwnPullRequest: boolean;
      readonly issues: readonly FrozenIssue[];
      readonly skipped: readonly SkippedIssue[];
      readonly dependencyCycles: readonly (readonly number[])[];
    }
  | { readonly started: false; readonly reason: string; readonly active?: AutoRunState };

/** Terminal for one attempt: how the loop left the run. */
type AttemptEnd = { readonly outcome: RunAttemptOutcome | "succeeded" };

/** A structural mismatch. Distinguished so no concluding side effect follows it. */
class StructuralError extends Error {
  public constructor(public readonly eligibilityReason: string) {
    super(eligibilityReason);
    this.name = "StructuralError";
  }
}

export class AutoRunEngine {
  #controller: AbortController | undefined;
  #state: AutoRunState | undefined;
  #record: AutoRunRecord | undefined;
  #persisted: PersistedAutoRunRecord | undefined;
  #eligibility: RecoveryEligibility | undefined;
  #workspace: RunWorkspace | undefined;
  #loop: Promise<void> = Promise.resolve();
  #wake: (() => void) | undefined;
  #checking: Promise<RecoveryEligibility> | undefined;
  #generation = 0;
  readonly #owners = new Map<number, PullRequestOwner>();
  readonly #pending = new Map<number, Omit<PullRequestOwner, "prNumber" | "issueNumber">>();
  readonly #openTerminals = new Set<TerminalId>();
  readonly #now: () => Date;
  readonly #runId: () => string;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #exists: (path: string) => boolean;

  public constructor(private readonly options: AutoRunEngineOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#runId = options.runIdFactory ?? (() => `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#exists = options.pathExists ?? existsSync;
  }

  public state(): AutoRunState | undefined {
    return this.#state;
  }

  /** The persisted record as last read, without touching the filesystem. */
  public persisted(): PersistedAutoRunRecord | undefined {
    return this.#persisted;
  }

  /** The last computed recovery eligibility, or `checking` while one is in flight. */
  public eligibility(): RecoveryEligibility | undefined {
    return this.#checking !== undefined ? { state: "checking" } : this.#eligibility;
  }

  public isActive(): boolean {
    return this.#controller !== undefined;
  }

  /** git in the checkout this run works in. */
  get #git(): GitClient {
    return this.#record === undefined ? this.#workspace?.git ?? this.options.git : this.#gitForRecord(this.#record);
  }

  #gitForRecord(record: AutoRunRecord): GitClient {
    const root = record.settings.workspaceRoot;
    const recorded = record.workspaceCreated === true && root !== undefined && this.#exists(root)
      ? this.options.gitFor?.(root)
      : undefined;
    return this.#workspace?.git ?? recorded ?? this.options.git;
  }

  #isolation(): { readonly isolation?: LaunchIsolation } {
    const workspace = this.#workspace;
    if (workspace === undefined || !workspace.isolated) return {};
    return { isolation: { cwd: workspace.root, denyTools: workspace.denyTools } };
  }

  #ownerCwd(): { readonly cwd?: string } {
    const isolation = this.#isolation().isolation;
    return isolation === undefined ? {} : { cwd: isolation.cwd };
  }

  public owner(prNumber: number): PullRequestOwner | undefined {
    return this.#owners.get(prNumber);
  }

  /**
   * Reads the record from disk and revalidates it. Called on activation, when
   * the Auto Run view becomes visible, on window focus, on a timer while that
   * view is showing, and immediately before Resume.
   *
   * Checks are serialized and generation-stamped: a slow check started under an
   * older record must never overwrite the verdict of a newer one.
   */
  public async refresh(): Promise<RecoveryEligibility | undefined> {
    if (this.#checking !== undefined) return this.#checking;
    const generation = ++this.#generation;
    this.#checking = this.#refresh(generation).finally(() => {
      this.#checking = undefined;
      this.options.onRecordChange?.();
    });
    this.options.onRecordChange?.();
    return this.#checking;
  }

  async #refresh(generation: number): Promise<RecoveryEligibility> {
    let persisted = await this.options.store.load().catch(() => undefined);
    if (generation !== this.#generation) return this.#eligibility ?? { state: "checking" };
    this.#persisted = persisted;
    if (persisted === undefined) {
      this.#eligibility = undefined;
      return { state: "checking" };
    }
    if (isUnsupportedRecord(persisted)) {
      this.#eligibility = { state: "broken", reason: UNSUPPORTED_RECORD_REASON };
      return this.#eligibility;
    }
    if (!this.isActive() && persisted.outcome === undefined) {
      persisted = { ...persisted, updatedAt: this.#now().toISOString(), outcome: { kind: "interrupted" } };
      await this.options.store.save(persisted);
      this.#persisted = persisted;
      this.options.activity?.runEnded(persisted, { kind: "interrupted" });
    }
    const { eligibility, observations } = await checkRun(persisted, this.#observationSources(persisted));
    if (generation !== this.#generation) return this.#eligibility ?? eligibility;
    this.#eligibility = eligibility;
    this.#titles = observations.titles;
    return eligibility;
  }

  #titles: Readonly<Record<string, string>> = {};

  /** Issue titles as GitHub last reported them, for display only. */
  public observedTitles(): Readonly<Record<string, string>> {
    return this.#titles;
  }

  #observationSources(record: AutoRunRecord): RunObservationSources {
    const root = record.settings.workspaceRoot;
    const recordedGit = record.workspaceCreated === true && root !== undefined && this.#exists(root)
      ? this.options.gitFor?.(root)
      : undefined;
    return {
      git: this.#workspace?.git ?? recordedGit ?? this.options.git,
      github: this.options.github,
      ...(root === undefined ? {} : { workspacePresent: async () => this.#exists(root) }),
    };
  }

  /**
   * Inspects exactly the inputs a new run uses without reserving an id or
   * performing any write.
   */
  public async dryRun(options: { readonly additionalGuideline?: string } = {}): Promise<AutoRunDryRunResult> {
    if (this.#state !== undefined) return { dryRun: true, inspected: false, reason: "a run is already active" };

    let status;
    let defaultBranch: string;
    try {
      status = await this.options.git.status();
      defaultBranch = await this.options.git.defaultBranch();
    } catch (error) {
      return { dryRun: true, inspected: false, reason: `the workspace is not a usable git repository (${message(error)})` };
    }
    const githubFailure = await this.#checkGitHubAuthentication();
    if (githubFailure !== undefined) return { dryRun: true, inspected: false, reason: githubFailure };

    const plan = planRun((await this.options.github.listImplementableIssues()).candidates);
    const settings = this.options.settings();
    const blockers: string[] = [];
    if (status.entries.length > 0 && this.options.workspaces?.isolates() !== true) {
      const paths = status.entries.map((entry) => entry.path);
      blockers.push(`the working tree is not clean: ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? `, and ${paths.length - 20} more` : ""}`);
    }
    if (plan.issues.length === 0) blockers.push(emptyQueueReason(plan.skipped));

    return {
      dryRun: true,
      inspected: true,
      ready: blockers.length === 0,
      blockers,
      reviewMode: settings.review,
      pauseAfterHitl: settings.pauseAfterHitl,
      ...guidelineProperty(options.additionalGuideline),
      isolatedWorkspace: this.options.workspaces?.isolates() ?? settings.worktree.enabled,
      keepsWorkspace: settings.worktree.keep,
      sessionBranch: "aboard/run/<run-id>",
      sessionBase: status.branch ?? defaultBranch,
      mergesItsOwnPullRequest: settings.mergeRunPullRequest,
      issues: plan.issues,
      skipped: plan.skipped,
      dependencyCycles: plan.dependencyCycles,
    };
  }

  /**
   * Starts a run. The complete plan is persisted before any workspace or branch
   * exists, so a crash between the two leaves a record describing exactly the
   * work that was agreed and nothing that was half-created.
   */
  public async start(options: { readonly additionalGuideline?: string } = {}): Promise<AutoRunStartResult> {
    if (this.#state !== undefined) return { started: false, reason: "a run is already active", active: this.#state };
    const existing = await this.options.store.load().catch(() => undefined);
    if (existing !== undefined) {
      return { started: false, reason: "a previous run is still unresolved; resume or discard it first" };
    }
    const settings = this.options.settings();
    const precondition = await this.#checkPreconditions();
    if (precondition !== undefined) return { started: false, reason: precondition };

    const plan = planRun((await this.options.github.listImplementableIssues()).candidates);
    if (plan.issues.length === 0) return { started: false, reason: emptyQueueReason(plan.skipped) };
    const returnBranch = await this.options.git.currentBranch() ?? await this.options.git.defaultBranch();
    const runId = this.#runId();
    const isolated = this.options.workspaces?.isolates() ?? settings.worktree.enabled;

    // A branch or pull request that already exists under a planned name is not
    // this run's: adopting it would mean committing onto work aboard cannot
    // prove it created.
    const conflict = await this.#findPlanConflict(plan.issues);
    if (conflict !== undefined) return { started: false, reason: conflict };

    const frozen: FrozenRunSettings = {
      review: settings.review,
      mergeStrategy: settings.mergeStrategy,
      mergeRunPullRequest: settings.mergeRunPullRequest,
      pauseAfterHitl: settings.pauseAfterHitl,
      pollSeconds: settings.pollSeconds,
      worktree: settings.worktree,
      ...(isolated
        ? { workspaceRoot: runWorkspacePath({ workspaceRoot: this.options.workspaceRoot, runId, root: settings.worktree.root }) }
        : {}),
      ...guidelineProperty(options.additionalGuideline),
    };
    const now = this.#now().toISOString();
    const record: AutoRunRecord = {
      version: 2,
      runId,
      startedAt: now,
      updatedAt: now,
      attempt: 1,
      settings: frozen,
      plan: plan.issues,
      progress: Object.fromEntries(plan.issues.map((issue) => [String(issue.number), { state: "pending" } as IssueProgress])),
      sessionBranch: sessionBranchName(runId),
      targetBranch: returnBranch,
      branchShas: {},
      currentIssue: undefined,
      checkpoint: "planned",
      reviewedIssues: [],
    };
    await this.options.store.save(record);
    this.#persisted = record;

    const afk = plan.issues.filter((issue) => issue.disposition === "afk").length;
    this.options.notifier.notify(autoRunMessage.started(afk, plan.issues.length - afk, frozen.review));
    for (const cycle of plan.dependencyCycles) {
      this.options.notifier.notify(`auto-run: dependency cycle detected among ${cycle.map((number) => `#${number}`).join(", ")}; ordering those issues oldest first.`);
    }
    for (const skipped of plan.skipped) {
      this.options.notifier.notify(`auto-run: issue #${skipped.number} skipped (${skipped.reason}).`);
    }
    this.options.activity?.runStarted(record, false);
    this.#begin(record);
    return {
      started: true,
      runId,
      reviewMode: frozen.review,
      sessionBranch: record.sessionBranch,
      sessionBase: record.targetBranch ?? await this.options.git.defaultBranch(),
      mergesItsOwnPullRequest: frozen.mergeRunPullRequest,
      issues: plan.issues,
      skipped: plan.skipped,
      dependencyCycles: plan.dependencyCycles,
    };
  }

  async #findPlanConflict(issues: readonly FrozenIssue[]): Promise<string | undefined> {
    for (const issue of issues) {
      if (await this.options.git.branchSha(issue.branch) !== undefined || await this.options.git.remoteBranchSha(issue.branch) !== undefined) {
        return `${issue.branch} already exists, so aboard cannot prove a run would own it; delete or rename it first`;
      }
      if (await this.options.github.findPullRequestForBranch(issue.branch) !== undefined) {
        return `a pull request already uses ${issue.branch}, so aboard cannot prove a run would own it; delete or rename the branch first`;
      }
    }
    return undefined;
  }

  /**
   * Resumes the persisted run. Revalidates first and refuses if broken, then
   * continues at the first unsatisfied checkpoint under the run's own frozen
   * settings — never today's configuration.
   */
  public async resume(): Promise<AutoRunStartResult> {
    if (this.#state !== undefined) return { started: false, reason: "a run is already active", active: this.#state };
    const eligibility = await this.refresh();
    const persisted = this.#persisted;
    if (persisted === undefined) return { started: false, reason: "there is no recorded run to resume" };
    if (isUnsupportedRecord(persisted)) return { started: false, reason: UNSUPPORTED_RECORD_REASON };
    if (eligibility?.state !== "resumable") {
      return { started: false, reason: eligibility?.state === "broken" ? eligibility.reason : "the run's state is still being checked" };
    }
    // The previous attempt's outcome is dropped rather than overwritten: the run
    // is in flight again, and a record still claiming it failed would show a
    // stale Resume/Discard card for as long as this attempt lasts.
    const { outcome: _previous, ...rest } = persisted;
    const record: AutoRunRecord = { ...rest, attempt: persisted.attempt + 1 };
    await this.options.store.save(record);
    this.#persisted = record;
    this.options.activity?.runStarted(record, true);
    this.#begin(record);
    return {
      started: true,
      runId: record.runId,
      reviewMode: record.settings.review,
      sessionBranch: record.sessionBranch,
      sessionBase: record.targetBranch ?? await this.options.git.defaultBranch(),
      mergesItsOwnPullRequest: record.settings.mergeRunPullRequest,
      issues: record.plan,
      skipped: [],
      dependencyCycles: [],
    };
  }

  /**
   * Stops the run at the user's request. A pause with no resume promise, not an
   * undo: the current agent's terminal is left open and nothing is rolled back.
   */
  public stop(reason = "stopped by the user"): void {
    if (this.#state === undefined) return;
    this.options.notifier.notify(autoRunMessage.stopped(this.#state.currentIssue, reason));
    this.#cancelled = true;
    this.#controller?.abort();
    this.#wake?.();
  }

  /**
   * The extension is shutting down. Recorded as interrupted rather than
   * cancelled: nobody chose to stop this run, and the two mean different things
   * to the user reading their history tomorrow.
   */
  public interrupt(reason = "the extension is shutting down"): void {
    if (this.#state === undefined) return;
    this.options.notifier.notify(autoRunMessage.stopped(this.#state.currentIssue, reason));
    this.#controller?.abort();
    this.#wake?.();
  }

  #cancelled = false;

  /** "Continue now": short-circuits the HITL wait's poll interval. */
  public continueNow(): void {
    this.#wake?.();
  }

  public async settle(): Promise<void> {
    await this.#loop;
  }

  /**
   * Forgets the recorded run, and — depending on `aboard.autoRun.discardBehavior`
   * — removes what it built. The record is always cleared, even when cleanup was
   * partial: a discard that leaves the user unable to start a new run because a
   * branch would not delete has failed at the one thing it must do.
   */
  public async discard(behavior?: DiscardBehavior): Promise<DiscardResult> {
    const persisted = this.#persisted ?? await this.options.store.load().catch(() => undefined);
    const chosen = behavior ?? this.options.discardBehavior?.() ?? "record-only";
    if (persisted === undefined || isUnsupportedRecord(persisted)) {
      await this.options.store.clear();
      if (persisted !== undefined) this.options.activity?.runDiscarded(persisted);
      this.#persisted = undefined;
      this.#eligibility = undefined;
      this.options.onRecordChange?.();
      return { behavior: chosen, deletedLocalBranches: [], deletedRemoteBranches: [], closedPullRequests: [], workspaceRemoved: false, leftovers: [] };
    }
    const plan = await this.planDiscard(chosen, persisted);
    const result = await this.#executeDiscard(persisted, plan);
    await this.options.store.clear();
    this.options.activity?.runDiscarded(persisted);
    this.#persisted = undefined;
    this.#eligibility = undefined;
    this.#record = undefined;
    this.options.onRecordChange?.();
    return result;
  }

  /** The cleanup the user is about to confirm, built from live observations. */
  public async planDiscard(behavior: DiscardBehavior, record?: AutoRunRecord): Promise<DiscardPlan> {
    const persisted = record ?? (this.#persisted !== undefined && !isUnsupportedRecord(this.#persisted) ? this.#persisted : undefined);
    if (persisted === undefined) {
      return { behavior, closeTerminals: false, removeWorkspace: false, localBranches: [], remoteBranches: [], pullRequests: [], retained: [] };
    }
    const { observations } = await checkRun(persisted, this.#observationSources(persisted));
    return planDiscard(persisted, behavior, observations);
  }

  async #executeDiscard(record: AutoRunRecord, plan: DiscardPlan): Promise<DiscardResult> {
    const leftovers: string[] = [...plan.retained];
    const git = this.#gitForRecord(record);
    if (plan.closeTerminals) {
      for (const terminalId of this.#openTerminals) {
        try { this.options.terminals.close(terminalId); } catch { /* already closed */ }
      }
      this.#openTerminals.clear();
    }
    const closedPullRequests: number[] = [];
    for (const pullRequest of plan.pullRequests) {
      try {
        if (await this.options.github.closePullRequestIf(pullRequest.number, { head: pullRequest.head, base: pullRequest.base })) {
          closedPullRequests.push(pullRequest.number);
        } else leftovers.push(`pull request #${pullRequest.number} no longer matched its recorded head and base and was left open`);
      } catch (error) {
        leftovers.push(`pull request #${pullRequest.number} could not be closed (${message(error)})`);
      }
    }
    const deletedRemoteBranches: string[] = [];
    for (const branch of plan.remoteBranches) {
      try {
        if (await git.deleteRemoteBranchAt(branch.name, branch.expectedSha)) deletedRemoteBranches.push(branch.name);
        else leftovers.push(`origin/${branch.name} had moved and was left in place`);
      } catch (error) {
        leftovers.push(`origin/${branch.name} could not be deleted (${message(error)})`);
      }
    }
    const deletedLocalBranches: string[] = [];
    for (const branch of plan.localBranches) {
      try {
        if (await git.deleteBranchAt(branch.name, branch.expectedSha)) deletedLocalBranches.push(branch.name);
        else leftovers.push(`${branch.name} had moved and was left in place`);
      } catch (error) {
        leftovers.push(`${branch.name} could not be deleted (${message(error)})`);
      }
    }
    let workspaceRemoved = false;
    if (plan.removeWorkspace && this.#workspace !== undefined && this.options.workspaces !== undefined) {
      try {
        const kept = await this.options.workspaces.release(this.#workspace, "drained");
        workspaceRemoved = kept === undefined;
        if (kept !== undefined) leftovers.push(`the run's checkout is still at ${kept.path}`);
      } catch (error) {
        leftovers.push(`the run's checkout could not be removed (${message(error)})`);
      }
      this.#workspace = undefined;
    } else if (plan.removeWorkspace && record.settings.workspaceRoot !== undefined) {
      try {
        workspaceRemoved = await this.options.workspaces?.removeRecorded?.(record.settings.workspaceRoot) ?? false;
        if (!workspaceRemoved) leftovers.push(`the run's checkout at ${record.settings.workspaceRoot} was not registered and was left in place`);
      } catch (error) {
        leftovers.push(`the run's checkout could not be removed (${message(error)})`);
      }
    }
    return { behavior: plan.behavior, deletedLocalBranches, deletedRemoteBranches, closedPullRequests, workspaceRemoved, leftovers };
  }

  #begin(record: AutoRunRecord): void {
    const controller = new AbortController();
    this.#controller = controller;
    this.#cancelled = false;
    this.#record = record;
    this.#eligibility = { state: "resumable" };
    this.#publish({
      runId: record.runId,
      phase: currentPhase(record),
      currentIssue: record.currentIssue,
      completedCount: completedCount(record),
      totalCount: record.plan.length,
      waiting: false,
      currentPullRequest: currentPullRequest(record),
    });
    const homeBranch = record.targetBranch;
    this.#loop = this.#run(controller.signal)
      .catch((error: unknown) => {
        this.options.log?.(`auto-run failed: ${message(error)}`);
      })
      .finally(() => {
        this.#controller = undefined;
        void this.#restoreOriginalBranch(homeBranch).finally(() => {
          this.#workspace = undefined;
          this.#publish(undefined);
          void this.refresh();
        });
      });
  }

  /**
   * Returns the checkout to the branch the user was on when the run started.
   * Best-effort and quiet on failure. A run with its own checkout has nothing to
   * restore: it never touched the user's HEAD.
   */
  async #restoreOriginalBranch(branch: string | undefined): Promise<void> {
    if (branch === undefined || this.#workspace?.isolated === true) return;
    try {
      const status = await this.options.git.status();
      if (status.branch === branch) return;
      if (status.entries.length > 0) {
        this.options.log?.(`auto-run: not returning to ${branch} — the working tree on ${status.branch ?? "a detached HEAD"} has uncommitted changes`);
        return;
      }
      await this.options.git.checkout(branch);
      this.options.notifier.notify(autoRunMessage.returned(branch));
    } catch (error) {
      this.options.log?.(`auto-run: could not return to ${branch}: ${message(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Record bookkeeping
  // ---------------------------------------------------------------------------

  get #current(): AutoRunRecord {
    if (this.#record === undefined) throw new Error("auto-run has no active record");
    return this.#record;
  }

  async #save(next: AutoRunRecord): Promise<void> {
    const stamped: AutoRunRecord = { ...next, updatedAt: this.#now().toISOString() };
    this.#record = stamped;
    this.#persisted = stamped;
    await this.options.store.save(stamped);
  }

  /**
   * Persists the intended before/after facts of a mutation *before* performing
   * it. Everything between this line and `#settled` is a crash window, and the
   * journal is what makes that window recoverable without ever adopting work the
   * run did not do.
   */
  async #journal(action: PendingAction): Promise<void> {
    await this.#save({ ...this.#current, pendingAction: action });
  }

  /** Clears the journal entry and records what the mutation actually produced. */
  async #settled(patch: Partial<AutoRunRecord> = {}): Promise<void> {
    const { pendingAction: _dropped, ...rest } = this.#current;
    await this.#save({ ...rest, ...patch } as AutoRunRecord);
  }

  #patchBranchSha(branch: string, sha: string): Partial<AutoRunRecord> {
    return { branchShas: { ...this.#current.branchShas, [branch]: sha } };
  }

  // ---------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------

  async #run(signal: AbortSignal): Promise<void> {
    let end: AttemptEnd = { outcome: { kind: "interrupted" } };
    try {
      await this.#recoverPendingAction();
      await this.#ensureWorkspace();
      await this.#ensureSessionBranch();
      end = await this.#drive(signal);
    } catch (error) {
      if (error instanceof StructuralError) {
        end = { outcome: { kind: "failed", reason: error.eligibilityReason } };
        // Nothing new is created after a structural failure: the repository is
        // not the one the record describes, so a concluding pull request would
        // be aboard's own guess about work it no longer understands.
        await this.#conclude(end, signal, { sideEffects: false });
        return;
      }
      end = { outcome: { kind: "failed", reason: message(error) } };
    }
    await this.#conclude(end, signal, { sideEffects: true });
  }

  async #conclude(end: AttemptEnd, signal: AbortSignal, options: { readonly sideEffects: boolean }): Promise<void> {
    let final = end;
    try {
      if (options.sideEffects) final = await this.#concludeRun(end, signal);
    } catch (error) {
      this.options.log?.(`auto-run could not conclude: ${message(error)}`);
    }
    const record = this.#record;
    if (record !== undefined) {
      if (final.outcome === "succeeded") {
        await this.options.store.clear().catch(() => undefined);
        this.#persisted = undefined;
        this.#eligibility = undefined;
      } else {
        await this.#save({ ...record, outcome: final.outcome }).catch(() => undefined);
      }
      this.options.activity?.runEnded(record, final.outcome);
      if (final.outcome !== "succeeded" && final.outcome.kind === "failed") {
        this.options.notifier.alert(autoRunMessage.stopped(record.currentIssue, final.outcome.reason));
      }
    }
    await this.#releaseWorkspace(final.outcome === "succeeded" ? "drained" : "interrupted");
    this.#record = undefined;
  }

  async #releaseWorkspace(outcome: RunWorkspaceOutcome): Promise<void> {
    const workspace = this.#workspace;
    if (workspace === undefined || this.options.workspaces === undefined) return;
    try {
      const kept = await this.options.workspaces.release(workspace, outcome);
      if (kept !== undefined) this.options.notifier.notify(autoRunMessage.workspaceKept(kept.path, kept.reason));
    } catch (error) {
      this.options.log?.(`auto-run could not release its checkout at ${workspace.root}: ${message(error)}`);
    }
  }

  /**
   * Re-enters the plan at the first unfinished entry, in the plan's own order.
   * Nothing is ever rediscovered: an issue somebody labelled `[AI]-afk` while
   * the run was in flight belongs to the next run, not this one.
   */
  async #drive(signal: AbortSignal): Promise<AttemptEnd> {
    while (!signal.aborted) {
      const record = this.#current;
      const issue = remainingIssues(record)[0];
      if (issue === undefined) {
        this.options.notifier.notify(autoRunMessage.complete(completedCount(record), 0));
        return { outcome: "succeeded" };
      }

      await this.#validate();
      const outcome = await this.#processIssue(issue, signal);
      if (outcome.kind === "aborted") {
        return { outcome: this.#cancelled ? { kind: "cancelled" } : { kind: "interrupted" } };
      }
      if (outcome.kind === "stopped") return { outcome: { kind: "failed", reason: outcome.reason } };

      if (record.settings.pauseAfterHitl && issue.disposition === "hitl" && remainingIssues(this.#current).length > 0) {
        this.options.notifier.notify(`auto-run: paused after hitl issue #${issue.number} (aboard.autoRun.pauseAfterHitl). Resume the run to continue.`);
        return { outcome: { kind: "cancelled" } };
      }
    }
    return { outcome: this.#cancelled ? { kind: "cancelled" } : { kind: "interrupted" } };
  }

  /** Validates the whole frozen plan before a phase side effect. */
  async #validate(): Promise<RunObservations> {
    const record = this.#current;
    const { eligibility, observations } = await checkRun(record, {
      git: this.#git,
      github: this.options.github,
      ...(record.settings.workspaceRoot === undefined
        ? {}
        : { workspacePresent: async () => this.#exists(record.settings.workspaceRoot!) }),
    });
    this.#titles = observations.titles;
    if (eligibility.state === "broken") throw new StructuralError(eligibility.reason);
    return observations;
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  async #advance(checkpoint: RunCheckpoint, patch: Partial<AutoRunRecord> = {}): Promise<void> {
    await this.#save({ ...this.#current, checkpoint, ...patch });
  }

  async #ensureWorkspace(): Promise<void> {
    const record = this.#current;
    if (this.options.workspaces === undefined) {
      if (checkpointReached(record.checkpoint, "workspace-ready")) return;
      await this.#advance("workspace-ready");
      return;
    }
    const workspace = await this.options.workspaces.prepare({
      runId: record.runId,
      sessionBranch: record.sessionBranch,
      base: record.targetBranch ?? await this.options.git.defaultBranch(),
      worktree: record.settings.worktree,
    });
    this.#workspace = workspace;
    if (workspace.isolated) this.options.notifier.notify(autoRunMessage.workspace(workspace.root));
    await this.#advance("workspace-ready", workspace.isolated ? { workspaceCreated: true } : {});
  }

  /**
   * Creates and publishes the session branch. Idempotent: a resumed run finds it
   * already there, and a run with its own checkout arrives with it created and
   * checked out already, so only the push is left.
   */
  async #ensureSessionBranch(): Promise<void> {
    const record = this.#current;
    const base = record.targetBranch ?? await this.#git.defaultBranch();
    this.options.notifier.notify(autoRunMessage.session(record.sessionBranch, base));
    await this.#git.fetch();
    const baseOnRemote = await this.#git.remoteBranchExists(base);
    if (!await this.#git.branchExists(record.sessionBranch)) {
      const baseSha = await this.#git.remoteBranchSha(base) ?? await this.#git.branchSha(base);
      if (baseSha === undefined) throw new Error(`the base branch ${base} no longer exists`);
      await this.#journal({ kind: "create-branch", branch: record.sessionBranch, base, baseSha });
      await this.#git.createBranch(record.sessionBranch, baseOnRemote ? `origin/${base}` : base);
    }
    const sha = await this.#git.branchSha(record.sessionBranch);
    if (sha !== undefined && this.#current.pendingAction?.kind === "create-branch" && sha !== this.#current.pendingAction.baseSha) {
      throw new StructuralError(`${record.sessionBranch} was created at an unexpected commit`);
    }
    if (await this.#git.remoteBranchSha(record.sessionBranch) !== sha) {
      await this.#journal({ kind: "push", branch: record.sessionBranch, sha: sha ?? "" });
      await this.#git.push(record.sessionBranch, true);
    }
    if (!baseOnRemote) this.options.notifier.notify(autoRunMessage.baseNotOnRemote(base));
    await this.#settled({ checkpoint: "session-branch-ready", ...(sha === undefined ? {} : this.#patchBranchSha(record.sessionBranch, sha)) });
  }

  /**
   * Adopts a mutation that succeeded across a crash, or clears a journal entry
   * whose effect never happened.
   *
   * The match has to be exact. A branch at some other SHA, a commit with a
   * different parent, a pull request opened against a different base: none of
   * these are the effect the run was about to perform, and treating them as
   * such is how an automated loop builds on a stranger's work.
   */
  async #recoverPendingAction(): Promise<void> {
    const record = this.#current;
    const action = record.pendingAction;
    if (action === undefined) return;
    switch (action.kind) {
      case "create-branch": {
        const sha = await this.#git.branchSha(action.branch);
        if (sha !== undefined && sha !== action.baseSha) {
          throw new StructuralError(`${action.branch} was created at an unexpected commit`);
        }
        await this.#settled(sha === action.baseSha ? this.#patchBranchSha(action.branch, sha) : {});
        return;
      }
      case "commit": {
        const head = await this.#git.commitDetails(action.branch).catch(() => undefined);
        const adopted = head !== undefined
          && head.parents.length === 1 && head.parents[0] === action.parentSha
          && head.message === action.message
          && head.treeSha === action.treeSha;
        if (adopted) {
          await this.#settled(this.#patchBranchSha(action.branch, head.sha));
          return;
        }
        if (head?.sha !== action.parentSha) {
          throw new StructuralError(`${action.branch} contains a commit other than the one aboard journalled`);
        }
        const status = await this.#git.status();
        const treeSha = await this.#git.stagedTreeSha().catch(() => undefined);
        if (status.branch !== action.branch || treeSha !== action.treeSha || !sameFingerprint(action.fingerprint, fingerprint(status))) {
          throw new StructuralError(`the staged changes on ${action.branch} no longer match the journalled commit`);
        }
        await this.#settled();
        return;
      }
      case "push": {
        const remote = await this.#git.remoteBranchSha(action.branch);
        await this.#settled(remote === action.sha ? this.#patchBranchSha(action.branch, action.sha) : {});
        return;
      }
      case "create-issue-pr": {
        const found = await this.options.github.findPullRequestForBranch(action.head).catch(() => undefined);
        const snapshot = found === undefined ? undefined : await this.options.github.getPullRequest(found).catch(() => undefined);
        if (snapshot !== undefined && (snapshot.headBranch !== action.head || snapshot.baseBranch !== action.base || snapshot.state !== "open")) {
          throw new StructuralError(`pull request #${found} does not match the issue pull request aboard was creating`);
        }
        const adopted = snapshot !== undefined;
        await this.#settled(adopted ? this.#issuePullRequestPatch(action.issue, found!) : {});
        return;
      }
      case "create-run-pr": {
        const found = await this.options.github.findPullRequestForBranch(action.head).catch(() => undefined);
        const snapshot = found === undefined ? undefined : await this.options.github.getPullRequest(found).catch(() => undefined);
        if (snapshot !== undefined && (snapshot.headBranch !== action.head || snapshot.baseBranch !== action.base || snapshot.state !== "open")) {
          throw new StructuralError(`pull request #${found} does not match the run pull request aboard was creating`);
        }
        const adopted = snapshot !== undefined;
        await this.#settled(adopted && found !== undefined ? { runPullRequest: found } : {});
        return;
      }
      case "merge-issue-pr":
      case "merge-run-pr": {
        const snapshot = await this.options.github.getPullRequest(action.prNumber).catch(() => undefined);
        if (snapshot?.state !== "merged") { await this.#settled(); return; }
        // The merge landed. Re-read the base branch so the record carries the
        // tip the merge produced, which is what later validation compares.
        await this.#git.fetch().catch(() => undefined);
        const baseSha = await this.#git.remoteBranchSha(action.base).catch(() => undefined);
        if (snapshot.headSha !== action.headSha || snapshot.mergeCommitSha === undefined || baseSha !== snapshot.mergeCommitSha) {
          throw new StructuralError(`pull request #${action.prNumber} merged without producing the recorded base branch`);
        }
        if (action.kind === "merge-issue-pr") {
          await this.#git.checkout(action.base);
          await this.#git.fastForward(action.base);
        }
        await this.#save({ ...this.#current, ...this.#patchBranchSha(action.base, baseSha) });
        return;
      }
    }
  }

  #issuePullRequestPatch(issueNumber: number, prNumber: number): Partial<AutoRunRecord> {
    const progress = issueProgress(this.#current, issueNumber);
    if (progress.state !== "current") return {};
    return withProgress(this.#current, issueNumber, { ...progress, prNumber }) as Partial<AutoRunRecord>;
  }

  // ---------------------------------------------------------------------------
  // One issue
  // ---------------------------------------------------------------------------

  async #processIssue(
    issue: FrozenIssue,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "done" } | { readonly kind: "aborted" } | { readonly kind: "stopped"; readonly reason: string }> {
    let phase: AutoRunPhase = "branch";
    let implementationSummary = "";
    let previous: string | undefined;
    let repeats = 0;

    const existing = issueProgress(this.#current, issue.number);
    let prNumber = existing.state === "current" ? existing.prNumber : undefined;
    const reviewed = new Set(this.#current.reviewedIssues);

    await this.#save({
      ...this.#current,
      checkpoint: "issue",
      currentIssue: issue.number,
      progress: { ...this.#current.progress, [String(issue.number)]: { state: "current", phase: "branch", ...(prNumber === undefined ? {} : { prNumber }) } },
    });

    for (;;) {
      if (signal.aborted) return { kind: "aborted" };
      const facts = await this.#observe(issue, prNumber, reviewed);
      prNumber = facts.pullRequest?.number ?? prNumber;
      const step = nextStep({ issue, baseBranch: this.#current.sessionBranch, reviewMode: this.#current.settings.review, facts });
      phase = step.action === "advance" || step.action === "stop" ? phase : step.action;
      repeats = step.action === previous ? repeats + 1 : 0;
      previous = step.action;
      if (repeats >= 2) {
        return { kind: "stopped", reason: `the ${step.action} phase did not reach its postcondition for issue #${issue.number}` };
      }
      this.#publish({
        runId: this.#current.runId,
        phase,
        currentIssue: issue.number,
        completedCount: completedCount(this.#current),
        totalCount: this.#current.plan.length,
        waiting: step.action === "await-approval",
        currentPullRequest: prNumber,
      });
      await this.#save(withProgress(this.#current, issue.number, {
        state: "current",
        phase,
        ...(prNumber === undefined ? {} : { prNumber }),
        ...(reviewed.has(issue.number) ? { reviewed: true as const } : {}),
      }));

      try {
        if (step.action !== "advance" && step.action !== "stop") await this.#validate();
        switch (step.action) {
          case "branch":
            await this.#branch(issue.branch, this.#current.sessionBranch);
            break;
          case "implement": {
            implementationSummary = await this.#implement(issue, signal);
            const produced = await this.#git.status();
            if (produced.entries.length === 0) {
              // A successful agent may correctly conclude the issue needs no
              // edit. Nothing to commit or review: discard the empty branch and
              // record the outcome as a legitimate one.
              await this.#discardEmptyBranch(issue.branch, this.#current.sessionBranch);
              this.#pending.delete(issue.number);
              this.options.notifier.notify(autoRunMessage.unchanged(issue.number));
              await this.#finishIssue(issue, { state: "done", result: "no-changes" });
              return { kind: "done" };
            }
            this.options.notifier.notify(autoRunMessage.implemented(issue.number, issue.branch));
            break;
          }
          case "commit": {
            const sha = await this.#commit(issue, implementationSummary);
            const opened = prNumber ?? await this.#openPullRequest(issue, implementationSummary);
            prNumber = opened;
            this.#attach(issue.number, opened);
            this.options.notifier.notify(autoRunMessage.committed(issue.number, sha.slice(0, 8), opened));
            break;
          }
          case "pr": {
            const opened = await this.#openPullRequest(issue, implementationSummary);
            prNumber = opened;
            this.#attach(issue.number, opened);
            this.options.notifier.notify(`auto-run: issue #${issue.number} opened PR #${opened}.`);
            break;
          }
          case "review":
            await this.#review(issue, step.prNumber, signal);
            reviewed.add(issue.number);
            await this.#save({ ...this.#current, reviewedIssues: [...reviewed] });
            break;
          case "await-approval": {
            const waited = await this.#awaitResolution(issue, step.prNumber, signal);
            if (waited === "aborted") return { kind: "aborted" };
            if (waited === "rejected") return { kind: "stopped", reason: `PR #${step.prNumber} was closed without merging` };
            break;
          }
          case "merge": {
            const merged = await this.#merge(issue, step.prNumber);
            // A conflict is a fact about one branch, but a run whose plan is
            // ordered by dependency cannot skip past it: the issues behind it
            // are the ones that would build on the work that will not land.
            if (merged !== "merged") return { kind: "stopped", reason: merged.reason };
            break;
          }
          case "cleanup": {
            const landed = facts.pullRequest?.state === "merged" ? facts.pullRequest.number : undefined;
            let closed = facts.issueClosed;
            if (landed !== undefined && !facts.issueClosed) closed = await this.#closeIssue(issue, landed);
            await this.#cleanup(this.#current.sessionBranch, issue.branch);
            await this.#finishIssue(issue, landed === undefined
              ? { state: "done", result: "no-changes" }
              : { state: "done", result: "landed", prNumber: landed, issueClosed: closed });
            return { kind: "done" };
          }
          case "advance":
            await this.#finishIssue(issue, { state: "done", result: "no-changes" });
            return { kind: "done" };
          case "stop":
            return { kind: "stopped", reason: step.reason };
        }
      } catch (error) {
        if (error instanceof StructuralError) throw error;
        return { kind: "stopped", reason: message(error) };
      }
    }
  }

  async #finishIssue(issue: FrozenIssue, progress: IssueProgress): Promise<void> {
    const { pendingAction: _settledAction, ...record } = withProgress(this.#current, issue.number, progress);
    await this.#save({ ...record, currentIssue: undefined });
  }

  /** Reads the repository for the current issue's phase decision. */
  async #observe(issue: FrozenIssue, knownPullRequest: number | undefined, reviewed: ReadonlySet<number>): Promise<RepositoryFacts> {
    const status = await this.#git.status();
    const branchExists = await this.#git.branchExists(issue.branch);
    const onBranch = status.branch === issue.branch;
    const baseBranch = this.#current.sessionBranch;
    const hasCommit = branchExists && onBranch && await this.#git.hasCommitFor(issue.number, baseBranch);
    const prNumber = (branchExists ? await this.options.github.findOpenPullRequestForBranch(issue.branch) : undefined) ?? knownPullRequest;
    const known = this.#owners.get(prNumber ?? -1);
    let pullRequest: RepositoryFacts["pullRequest"];
    const snapshot = prNumber === undefined ? undefined : await this.options.github.getPullRequest(prNumber);
    if (prNumber !== undefined && snapshot !== undefined) {
      const review = await this.options.github.getReviewState(prNumber);
      pullRequest = { number: prNumber, state: snapshot.state, approvedByOther: review.decision === "approved" };
    }
    return {
      currentBranch: status.branch,
      branchExists,
      workingTreeDirty: status.entries.length > 0,
      dirtyPaths: status.entries.map((entry) => entry.path),
      hasCommit,
      commitPushed: hasCommit && await this.#git.isPushed(issue.branch),
      pullRequest,
      reviewed: reviewed.has(issue.number) || (known !== undefined && known.type !== "implementer"),
      issueClosed: (await this.options.github.getIssue(issue.number))?.state === "closed",
    };
  }

  async #branch(branch: string, base: string): Promise<void> {
    await this.#git.fetch();
    await this.#git.checkout(base);
    await this.#git.fastForward(base);
    if (await this.#git.branchExists(branch)) {
      await this.#git.checkout(branch);
    } else {
      const baseSha = await this.#git.branchSha(base) ?? "";
      if (baseSha.length === 0) throw new Error(`the base branch ${base} no longer exists`);
      await this.#journal({ kind: "create-branch", branch, base, baseSha });
      await this.#git.createBranch(branch, base);
    }
    const sha = await this.#git.branchSha(branch);
    if (sha !== undefined && this.#current.pendingAction?.kind === "create-branch" && sha !== this.#current.pendingAction.baseSha) {
      throw new StructuralError(`${branch} was created at an unexpected commit`);
    }
    await this.#settled(sha === undefined ? {} : this.#patchBranchSha(branch, sha));
  }

  #difficulty(issue: FrozenIssue): { readonly difficulty?: IssueDifficulty } {
    return issue.difficulty === undefined ? {} : { difficulty: issue.difficulty };
  }

  /**
   * The run-wide guidance a worker receives, plus — only when this issue already
   * carries uncommitted edits from a worker that failed or was interrupted — one
   * sentence telling it not to trust them. Exactly one: a recovery prompt that
   * explains the whole crash invites the agent to investigate the crash rather
   * than finish the issue.
   */
  async #guidance(issue: FrozenIssue): Promise<{ readonly additionalGuideline?: string }> {
    const base = this.#current.settings.additionalGuideline;
    const status = await this.#git.status().catch(() => undefined);
    const dirty = status !== undefined && status.entries.length > 0 && status.branch === issue.branch;
    if (!dirty) return guidelineProperty(base);
    return { additionalGuideline: base === undefined ? DIRTY_RECOVERY_SENTENCE : `${base}\n\n${DIRTY_RECOVERY_SENTENCE}` };
  }

  async #implement(issue: FrozenIssue, signal: AbortSignal): Promise<string> {
    const outcome = await this.options.launcher.runAutomated({
      type: "implementer",
      issues: [issue.number],
      description: `address issue ${issue.number}`,
      ...(issue.chrome === true ? { chrome: true } : {}),
      ...this.#difficulty(issue),
      prompt: `Address issue #${issue.number} on branch \`${issue.branch}\`, which is already checked out. Work only in the directory you started in; it holds the whole repository. Leave your work uncommitted in the working tree: aboard commits, pushes, and opens the pull request for you. Use git and gh only for read-only inspection.`,
      ...(await this.#guidance(issue)),
      expectsUncommittedTree: true,
      ...this.#isolation(),
    }, signal);
    this.#openTerminals.add(outcome.terminalId);
    if (outcome.result.outcome === "failed") throw new Error(`implementer failed: ${outcome.result.failure.type}`);
    this.#remember(issue, outcome, "implementer");
    await this.#validate();
    await this.#comment(issue.number, outcome.result.lastAssistantMessage);
    return outcome.result.lastAssistantMessage;
  }

  /**
   * Posts the implementer's own account of the change on the issue it resolved.
   * Best-effort: no phase's postcondition depends on a comment.
   */
  async #comment(issueNumber: number, summary: string): Promise<void> {
    const body = issueCommentBody(summary);
    if (body === undefined) return;
    try {
      await this.options.github.addIssueComment(issueNumber, body);
    } catch (error) {
      this.options.log?.(`auto-run could not comment on issue #${issueNumber}: ${message(error)}`);
    }
  }

  /**
   * Closes the issue its pull request just merged, and reports whether that
   * worked. GitHub only honours a closing keyword on a merge into the default
   * branch, and nothing here merges there, so without this every issue would
   * stay open — leaving its dependents blocked and the roadmap wrong.
   */
  async #closeIssue(issue: FrozenIssue, prNumber: number): Promise<boolean> {
    const record = this.#current;
    const base = record.targetBranch ?? "the branch you started on";
    try {
      await this.options.github.closeIssue(issue.number, issueClosedComment(prNumber, record.sessionBranch, base));
      this.options.notifier.notify(autoRunMessage.closed(issue.number));
      return true;
    } catch (error) {
      this.options.notifier.notify(autoRunMessage.notClosed(issue.number, message(error)));
      return false;
    }
  }

  async #commit(issue: FrozenIssue, summary: string): Promise<string> {
    const current = await this.#git.currentBranch();
    if (current !== issue.branch) {
      throw new Error(`the repository is on ${current ?? "a detached HEAD"} but issue #${issue.number} belongs on ${issue.branch}`);
    }
    const status = await this.#git.status();
    if (status.entries.length > 0) {
      const parent = await this.#git.headSha(false);
      const subject = commitSubject(issue.title);
      const body = `Addresses #${issue.number}.\n\n${summary.trim().slice(0, 500)}`.trim();
      await this.#git.add();
      const staged = await this.#git.status();
      await this.#journal({
        kind: "commit",
        branch: issue.branch,
        parentSha: parent,
        message: `${subject}\n\n${body}`,
        treeSha: await this.#git.stagedTreeSha(),
        fingerprint: fingerprint(staged),
      });
      await this.#git.commit(subject, body);
      const committedSha = await this.#git.headSha(false);
      await this.#settled(this.#patchBranchSha(issue.branch, committedSha));
    } else if (!await this.#git.hasCommitFor(issue.number, this.#current.sessionBranch)) {
      throw new Error("the implementer produced no changes");
    }
    const sha = await this.#git.headSha(false);
    if (await this.#git.remoteBranchSha(issue.branch) !== sha) {
      await this.#journal({ kind: "push", branch: issue.branch, sha });
      await this.#git.push(issue.branch, true);
      await this.#settled(this.#patchBranchSha(issue.branch, sha));
    } else {
      await this.#save({ ...this.#current, branchShas: { ...this.#current.branchShas, [issue.branch]: sha } });
    }
    return sha;
  }

  async #openPullRequest(issue: FrozenIssue, summary: string): Promise<number> {
    const base = this.#current.sessionBranch;
    const existing = await this.options.github.findPullRequestForBranch(issue.branch);
    if (existing !== undefined) {
      const snapshot = await this.options.github.getPullRequest(existing);
      if (snapshot?.state === "open" && snapshot.headBranch === issue.branch && snapshot.baseBranch === base) return existing;
      throw new StructuralError(`pull request #${existing} already uses ${issue.branch} but is not this run's open issue pull request`);
    }
    await this.#journal({ kind: "create-issue-pr", issue: issue.number, head: issue.branch, base });
    const created = await this.options.github.createPullRequest({
      title: issue.title,
      body: pullRequestBody(summary, issue.number),
      head: issue.branch,
      base,
    });
    await this.#settled();
    return created;
  }

  async #review(issue: FrozenIssue, prNumber: number, signal: AbortSignal): Promise<void> {
    const guidance = await this.#guidance(issue);
    if (issue.disposition === "hitl") {
      const handles = await this.options.launcher.launchInteractive({
        type: "pr-doctor-hitl",
        issues: [issue.number],
        pullRequest: prNumber,
        description: `review pull request ${prNumber}`,
        ...guidance,
        ...this.#difficulty(issue),
        ...this.#isolation(),
      }, "auto-run");
      this.#openTerminals.add(handles.terminalId);
      this.#owners.set(prNumber, { prNumber, ...handles, type: "pr-doctor-hitl", issueNumber: issue.number, ...this.#difficulty(issue), ...this.#ownerCwd() });
      return;
    }
    const outcome = await this.options.launcher.runAutomated({
      type: "pr-doctor-afk",
      issues: [issue.number],
      pullRequest: prNumber,
      description: `review pull request ${prNumber}`,
      ...guidance,
      expectsUncommittedTree: true,
      ...this.#difficulty(issue),
      ...this.#isolation(),
    }, signal);
    this.#openTerminals.add(outcome.terminalId);
    if (outcome.result.outcome === "failed") throw new Error(`pr-doctor-afk failed: ${outcome.result.failure.type}`);
    this.#remember(issue, outcome, "pr-doctor-afk");

    await this.#validate();
    const status = await this.#git.status();
    this.options.notifier.notify(autoRunMessage.reviewed(issue.number, status.entries.map((entry) => entry.path)));
    if (status.entries.length === 0) return;
    await this.#commitFixes(issue, `Address review findings on #${issue.number}`, outcome.result.lastAssistantMessage.trim().slice(0, 500));
  }

  /** A follow-up commit on an issue branch, journalled like every other mutation. */
  async #commitFixes(issue: FrozenIssue, subject: string, body: string): Promise<void> {
    const status = await this.#git.status();
    if (status.entries.length === 0) return;
    const parent = await this.#git.headSha(false);
    await this.#git.add();
    const staged = await this.#git.status();
    await this.#journal({
      kind: "commit",
      branch: issue.branch,
      parentSha: parent,
      message: `${subject}\n\n${body}`,
      treeSha: await this.#git.stagedTreeSha(),
      fingerprint: fingerprint(staged),
    });
    await this.#git.commit(subject, body);
    const committedSha = await this.#git.headSha(false);
    await this.#settled(this.#patchBranchSha(issue.branch, committedSha));
    const sha = await this.#git.headSha(false);
    await this.#journal({ kind: "push", branch: issue.branch, sha });
    await this.#git.push(issue.branch, false);
    await this.#settled(this.#patchBranchSha(issue.branch, sha));
  }

  async #awaitResolution(issue: FrozenIssue, prNumber: number, signal: AbortSignal): Promise<"merged" | "rejected" | "aborted"> {
    this.options.notifier.notify(autoRunMessage.waiting(issue.number, prNumber));
    while (!signal.aborted) {
      await this.#validate();
      await this.#captureOpenWork(issue, prNumber);
      const snapshot = await this.options.github.getPullRequest(prNumber);
      if (snapshot?.state === "merged") {
        this.options.notifier.notify(autoRunMessage.resolved(prNumber));
        return "merged";
      }
      if (snapshot?.state === "closed") return "rejected";
      if ((await this.options.github.getReviewState(prNumber)).decision === "approved") return "merged";
      await this.#waitForPoll(this.#current.settings.pollSeconds, signal);
    }
    return "aborted";
  }

  /**
   * Commits and pushes whatever is in the working tree while a hitl pull request
   * waits, so the user does not merge a pull request missing the fixes they just
   * approved. Always announced: a commit nobody asked for must not be silent.
   */
  async #captureOpenWork(issue: FrozenIssue, prNumber: number): Promise<void> {
    const status = await this.#git.status();
    if (status.entries.length === 0) return;
    if (status.branch !== issue.branch) {
      this.options.log?.(`auto-run left uncommitted work on ${status.branch ?? "a detached HEAD"}: issue #${issue.number} belongs on ${issue.branch}`);
      return;
    }
    const paths = status.entries.map((entry) => entry.path);
    await this.#commitFixes(issue, `Address review findings on #${issue.number}`, `Applied while PR #${prNumber} was open for review.`);
    this.options.notifier.notify(autoRunMessage.captured(issue.number, prNumber, paths));
  }

  /**
   * Merges the pull request, or reports why the run cannot. A conflict is the
   * one failure worth attempting to repair here, because the run creates it.
   */
  async #merge(issue: FrozenIssue, prNumber: number): Promise<"merged" | { readonly reason: string; readonly pullRequestUrl: string | undefined }> {
    const base = this.#current.sessionBranch;
    const strategy = this.#current.settings.mergeStrategy;
    const snapshot = await this.options.github.getPullRequest(prNumber);
    if (snapshot?.state !== "merged") {
      if (snapshot?.mergeable === "conflicting") {
        if (!await this.#reconcile(issue.branch, base)) {
          return { reason: `PR #${prNumber} conflicts with ${base} and the conflict is not one aboard can resolve`, pullRequestUrl: snapshot.url };
        }
        this.options.notifier.notify(autoRunMessage.reconciled(issue.number, prNumber, base));
      }
      const headSha = await this.#git.remoteBranchSha(issue.branch) ?? await this.#git.branchSha(issue.branch);
      const baseShaBefore = await this.#git.remoteBranchSha(base) ?? await this.#git.branchSha(base);
      if (headSha === undefined || baseShaBefore === undefined) throw new Error(`the branches for PR #${prNumber} no longer exist`);
      await this.#journal({ kind: "merge-issue-pr", prNumber, head: issue.branch, base, headSha, baseSha: baseShaBefore });
      try {
        // `gh pr merge --delete-branch` deletes the local branch too and may
        // move HEAD behind the engine's back. Keep the CLI merge remote-only;
        // cleanup removes the exact recorded local and remote refs through the
        // SHA-guarded git boundary after the merge is adopted.
        await this.options.github.mergePullRequest(prNumber, strategy, false);
      } catch (error) {
        const after = await this.options.github.getPullRequest(prNumber);
        if (after?.state === "merged") {
          this.options.log?.(`auto-run: PR #${prNumber} was already merged when the merge failed (${message(error)})`);
        } else if (after?.mergeable === "conflicting") {
          await this.#settled();
          return { reason: `PR #${prNumber} conflicts with ${base}`, pullRequestUrl: after.url };
        } else {
          await this.#settled();
          throw new Error(`merging PR #${prNumber} failed (${message(error)}). If the branch requires a review, auto-run cannot approve its own pull request — merge it yourself and resume the run.`);
        }
      }
      await this.#git.fetch().catch(() => undefined);
      const baseSha = await this.#git.remoteBranchSha(base).catch(() => undefined);
      const after = await this.options.github.getPullRequest(prNumber).catch(() => undefined);
      if (baseSha === undefined || after?.headSha !== headSha || after.mergeCommitSha === undefined || baseSha !== after.mergeCommitSha) {
        throw new StructuralError(`pull request #${prNumber} merged without producing the recorded base branch`);
      }
      await this.#git.checkout(base);
      await this.#git.fastForward(base);
      await this.#save({ ...this.#current, ...(baseSha === undefined ? {} : this.#patchBranchSha(base, baseSha)) });
    }
    this.options.notifier.notify(autoRunMessage.merged(issue.number, base));
    this.#owners.delete(prNumber);
    return "merged";
  }

  async #reconcile(branch: string, base: string): Promise<boolean> {
    const status = await this.#git.status();
    if (status.branch !== branch || status.entries.length > 0) return false;
    await this.#git.fetch();
    if (!await this.#git.mergeFromRemote(base)) return false;
    const sha = await this.#git.headSha(false);
    await this.#journal({ kind: "push", branch, sha });
    await this.#git.push(branch, false);
    await this.#settled(this.#patchBranchSha(branch, sha));
    return true;
  }

  async #cleanup(sessionBranch: string, issueBranch?: string): Promise<void> {
    for (const terminalId of this.#openTerminals) {
      try { this.options.terminals.close(terminalId); } catch { /* already closed */ }
    }
    this.#openTerminals.clear();
    try {
      await this.#git.checkout(sessionBranch);
      const expectedSha = issueBranch === undefined ? undefined : this.#current.branchShas[issueBranch];
      if (issueBranch !== undefined && expectedSha !== undefined) {
        await this.#git.deleteBranchAt(issueBranch, expectedSha);
        await this.#git.deleteRemoteBranchAt(issueBranch, expectedSha);
      }
    } catch (error) {
      this.options.log?.(`auto-run cleanup could not return to ${sessionBranch}: ${message(error)}`);
    }
  }

  async #discardEmptyBranch(issueBranch: string, sessionBranch: string): Promise<void> {
    for (const terminalId of this.#openTerminals) {
      try { this.options.terminals.close(terminalId); } catch { /* already closed */ }
    }
    this.#openTerminals.clear();
    await this.#git.checkout(sessionBranch);
    await this.#git.deleteBranch(issueBranch);
  }

  // ---------------------------------------------------------------------------
  // Conclusion
  // ---------------------------------------------------------------------------

  /**
   * Opens — and, when the user allowed it, merges — the run's own pull request.
   * This is the only place a run touches a branch the user owns.
   *
   * It runs on every controlled exit, including a stop or a failure, because
   * work already merged onto the session branch is invisible until something
   * points at it. It never throws: the run is over.
   */
  async #concludeRun(end: AttemptEnd, signal: AbortSignal): Promise<AttemptEnd> {
    const record = this.#current;
    const landed = landedIssues(record);
    if (landed.length === 0) {
      // Nothing to carry anywhere. A plan whose every entry needed no change is
      // a complete run, not a run missing its pull request.
      return end;
    }
    await this.#validate();
    await this.#advance("concluding");
    const base = record.targetBranch ?? await this.#git.defaultBranch();
    try {
      if (!await this.#git.remoteBranchExists(base)) {
        this.options.notifier.alert(autoRunMessage.runNotOpened(record.sessionBranch, base, `${base} is not on origin`));
        return failIfSucceeded(end, `${base} is not on origin, so the run's pull request could not be opened`);
      }
      let prNumber = record.runPullRequest ?? await this.options.github.findOpenPullRequestForBranch(record.sessionBranch);
      if (prNumber === undefined) {
        await this.#journal({ kind: "create-run-pr", head: record.sessionBranch, base });
        prNumber = await this.options.github.createPullRequest({
          title: runPullRequestTitle(landed),
          body: runPullRequestBody(landed, record.sessionBranch, base),
          head: record.sessionBranch,
          base,
        });
        await this.#settled({ runPullRequest: prNumber });
      } else if (record.runPullRequest !== prNumber) {
        await this.#save({ ...this.#current, runPullRequest: prNumber });
      }
      this.options.notifier.notify(autoRunMessage.runOpened(prNumber, base, landed.length));
      const snapshot = await this.options.github.getPullRequest(prNumber);
      // A run the user interrupted must not finish by landing a batch of
      // automated work on their branch.
      if (!record.settings.mergeRunPullRequest || signal.aborted) {
        this.options.notifier.alert(autoRunMessage.runWaiting(prNumber, base), snapshot?.url);
        return end;
      }
      const merged = await this.#mergeRun(prNumber, base);
      if (!merged) return failIfSucceeded(end, `the run's pull request #${prNumber} could not be merged into ${base}`);
      if (end.outcome === "succeeded") await this.#settled({ checkpoint: "complete" });
      else await this.#settled();
      return end;
    } catch (error) {
      this.options.notifier.alert(autoRunMessage.runNotOpened(record.sessionBranch, base, message(error)));
      return failIfSucceeded(end, `the run's pull request could not be opened (${message(error)})`);
    }
  }

  async #mergeRun(prNumber: number, base: string): Promise<boolean> {
    const snapshot = await this.options.github.getPullRequest(prNumber);
    if (snapshot?.state === "merged") {
      this.options.notifier.notify(autoRunMessage.runMerged(prNumber, base));
      return true;
    }
    if (snapshot?.mergeable === "conflicting" && !await this.#syncSessionBranch(base)) {
      this.options.notifier.alert(autoRunMessage.runParked(prNumber, base, `it conflicts with ${base}`), snapshot.url);
      return false;
    }
    const headSha = await this.#git.remoteBranchSha(this.#current.sessionBranch) ?? await this.#git.branchSha(this.#current.sessionBranch);
    const baseSha = await this.#git.remoteBranchSha(base) ?? await this.#git.branchSha(base);
    if (headSha === undefined || baseSha === undefined) return false;
    await this.#journal({ kind: "merge-run-pr", prNumber, head: this.#current.sessionBranch, base, headSha, baseSha });
    try {
      // The session branch survives its merge: unmerged issue pull requests
      // still target it, and deleting a base branch closes them.
      await this.options.github.mergePullRequest(prNumber, this.#current.settings.mergeStrategy, false);
    } catch (error) {
      const after = await this.options.github.getPullRequest(prNumber);
      if (after?.state !== "merged") {
        await this.#settled();
        this.options.notifier.alert(autoRunMessage.runParked(prNumber, base, message(error)), after?.url ?? snapshot?.url);
        return false;
      }
    }
    await this.#git.fetch().catch(() => undefined);
    const baseShaAfter = await this.#git.remoteBranchSha(base).catch(() => undefined);
    const after = await this.options.github.getPullRequest(prNumber).catch(() => undefined);
    if (after?.headSha !== headSha || after.mergeCommitSha === undefined || baseShaAfter !== after.mergeCommitSha) {
      throw new StructuralError(`pull request #${prNumber} merged without producing the recorded target branch`);
    }
    this.options.notifier.notify(autoRunMessage.runMerged(prNumber, base));
    return true;
  }

  async #syncSessionBranch(base: string): Promise<boolean> {
    const branch = this.#current.sessionBranch;
    try {
      const status = await this.#git.status();
      if (status.entries.length > 0) return false;
      if (status.branch !== branch) await this.#git.checkout(branch);
      await this.#git.fetch();
      await this.#git.fastForward(branch);
      return await this.#reconcile(branch, base);
    } catch (error) {
      this.options.log?.(`auto-run could not reconcile ${branch} with ${base}: ${message(error)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Preconditions and bookkeeping
  // ---------------------------------------------------------------------------

  async #checkPreconditions(): Promise<string | undefined> {
    let status;
    try {
      status = await this.options.git.status();
      await this.options.git.defaultBranch();
    } catch (error) {
      return `the workspace is not a usable git repository (${message(error)})`;
    }
    const githubFailure = await this.#checkGitHubAuthentication();
    if (githubFailure !== undefined) return githubFailure;
    if (status.entries.length > 0 && this.options.workspaces?.isolates() !== true) {
      const paths = status.entries.map((entry) => entry.path);
      return `the working tree is not clean: ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? `, and ${paths.length - 20} more` : ""}`;
    }
    return undefined;
  }

  async #checkGitHubAuthentication(): Promise<string | undefined> {
    try {
      await this.options.github.checkAuthentication();
      return undefined;
    } catch (error) {
      return `GitHub CLI cannot authenticate to this repository; run gh auth status and gh auth login if needed (${message(error)})`;
    }
  }

  #remember(issue: FrozenIssue, outcome: AutomatedLaunchOutcome, type: PullRequestOwner["type"]): void {
    this.#pending.set(issue.number, {
      agentId: outcome.agentId,
      sessionId: outcome.sessionId,
      terminalId: outcome.terminalId,
      type,
      ...this.#difficulty(issue),
      ...this.#ownerCwd(),
    });
    this.#attach(issue.number, this.#prForIssue(issue.number));
  }

  #attach(issueNumber: number, prNumber: number | undefined): void {
    const pending = this.#pending.get(issueNumber);
    if (pending === undefined || prNumber === undefined) return;
    this.#owners.set(prNumber, { ...pending, prNumber, issueNumber });
  }

  #prForIssue(issueNumber: number): number | undefined {
    for (const [prNumber, owner] of this.#owners) {
      if (owner.issueNumber === issueNumber) return prNumber;
    }
    return undefined;
  }

  async #waitForPoll(seconds: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => { if (!settled) { settled = true; this.#wake = undefined; resolve(); } };
      this.#wake = finish;
      void this.#sleep(Math.max(1, seconds) * 1_000, signal).then(finish, finish);
    });
  }

  #publish(state: AutoRunState | undefined): void {
    this.#state = state;
    this.options.onStateChange?.(state);
    this.options.onRecordChange?.();
  }
}

/** A concluding step that failed turns an otherwise successful run into a resumable failure. */
function failIfSucceeded(end: AttemptEnd, reason: string): AttemptEnd {
  return end.outcome === "succeeded" ? { outcome: { kind: "failed", reason } } : end;
}

const CHECKPOINT_ORDER: readonly RunCheckpoint[] = ["planned", "workspace-ready", "session-branch-ready", "issue", "concluding", "complete"];

export function checkpointReached(current: RunCheckpoint, wanted: RunCheckpoint): boolean {
  return CHECKPOINT_ORDER.indexOf(current) >= CHECKPOINT_ORDER.indexOf(wanted);
}

export function currentPhase(record: AutoRunRecord): AutoRunPhase {
  if (record.currentIssue === undefined) return "branch";
  const progress = issueProgress(record, record.currentIssue);
  return progress.state === "current" ? progress.phase : "branch";
}

export function currentPullRequest(record: AutoRunRecord): number | undefined {
  if (record.currentIssue === undefined) return undefined;
  const progress = issueProgress(record, record.currentIssue);
  return progress.state === "current" ? progress.prNumber : undefined;
}

/** Whether the record describes a run that reached its own definition of success. */
export function recordSucceeded(record: AutoRunRecord): boolean {
  return runSucceeded(record, record.checkpoint === "complete");
}

/** Runs the validator against pre-gathered observations; exported for tests. */
export function eligibilityFor(record: AutoRunRecord, observations: RunObservations): RecoveryEligibility {
  return validateRun(record, observations);
}

/** Whether a fresh worker on this issue needs the recovery sentence. */
export function needsDirtyRecoveryPrompt(record: AutoRunRecord, observations: RunObservations): boolean {
  return hasTrustedDirtyWork(record, observations);
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function fingerprint(status: GitStatus): readonly string[] {
  return status.entries.map((entry) => `${entry.status}:${entry.path}`).sort();
}

function sameFingerprint(expected: readonly string[], observed: readonly string[]): boolean {
  return expected.length === observed.length && expected.every((entry, index) => entry === observed[index]);
}

function guidelineProperty(value: string | undefined): { readonly additionalGuideline?: string } {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? {} : { additionalGuideline: trimmed };
}

/**
 * Why nothing can run. "Nothing is labelled" and "everything is unclassified or
 * blocked" are different problems with different fixes, so the skip reasons are
 * named rather than collapsed into one refusal.
 */
function emptyQueueReason(skipped: readonly SkippedIssue[]): string {
  if (skipped.length === 0) return "no open issue is labelled [AI]-afk or [AI]-hitl";
  const listed = skipped.slice(0, 20).map((entry) => `#${entry.number} (${entry.reason})`).join(", ");
  const rest = skipped.length > 20 ? `, and ${skipped.length - 20} more` : "";
  return `no open issue is ready to address: ${listed}${rest}`;
}
