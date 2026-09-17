
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";

import {
  autoRunTargetBranchBlocker,
  autoRunMessage,
  classifyWorkerResult,
  classifyHitlCommit,
  explorationCommentBody,
  issueClosedComment,
  issueCommentBody,
  nextStep,
  pullRequestBody,
  runPullRequestBody,
  runPullRequestTitle,
  sessionBranchName,
  unpublishedTargetWarning,
  type AutoRunDryRunResult,
  type AutoRunPhase,
  type AutoRunSettings,
  type CandidateIssue,
  type RepositoryFacts,
  type SkippedIssue,
  type WorkerRepositoryState,
  type WorkerRole,
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
  type RecoveryEligibility,
  type RunAttemptOutcome,
  type RunCheckpoint,
} from "../domain/run-plan.js";
import { validateRun, type RunObservations } from "../domain/run-validation.js";
import { planDiscard, type DiscardBehavior, type DiscardPlan, type DiscardResult } from "../domain/run-cleanup.js";
import type { AgentSession, TerminalId } from "../domain/contracts.js";
import type { LaunchOrigin } from "../domain/lease.js";
import { GitBoundaryError, type GitClient } from "../git/client.js";
import { GitHubBoundaryError } from "../github/client.js";
import type { AutomatedLaunchOutcome, DelegationLaunchInput, InteractiveLaunchHandles, LaunchIsolation } from "../bridge/delegation.js";
import { runWorkspacePath, type RunWorkspace, type RunWorkspaceOutcome, type RunWorkspaceProvider } from "./worktree.js";
import { checkRun, type RunObservationSources } from "./observation.js";
import type { IssueDifficulty } from "../shared/labels.js";
import {
  autoRunExplorePrompt,
  autoRunHitlReviewerPrompt,
  autoRunImplementerPrompt,
  autoRunReviewerPrompt,
  autoRunReviewGuideline,
  requireExploreReport,
} from "../platform/prompts.js";

export interface PullRequestObservation {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly state: "open" | "closed" | "merged";
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha?: string;
  readonly mergeCommitSha?: string;
  /** Comes back in the same query as the rest, sparing a second pull-request read. */
  readonly reviewDecision?: "approved" | "changes-requested" | "reviewed" | "unreviewed";
}

/** The GitHub surface the engine needs, narrowed so tests can fake it whole. */
export interface AutoRunGitHub {
  /** Proves that gh can authenticate to and resolve the workspace repository. */
  checkAuthentication(): Promise<void>;
  listImplementableIssues(): Promise<{ readonly candidates: readonly CandidateIssue[] }>;
  getIssue(number: number): Promise<{ readonly state: "open" | "closed"; readonly labels: readonly string[]; readonly comments?: readonly { readonly body: string }[] } | undefined>;
  addIssueComment(number: number, body: string): Promise<void>;
  closeIssue(number: number, comment: string): Promise<void>;
  createPullRequest(input: { readonly title: string; readonly body: string; readonly head: string; readonly base: string }): Promise<number>;
  updatePullRequest?(number: number, input: { readonly title: string; readonly body: string }): Promise<void>;
  findOpenPullRequestForBranch(branch: string): Promise<number | undefined>;
  findPullRequestForBranch(branch: string): Promise<number | undefined>;
  /** The batched form of `findPullRequestForBranch`, one round trip for many branches. */
  findPullRequestsByHead?(branches: readonly string[]): Promise<ReadonlyMap<string, number>>;
  getPullRequest(number: number): Promise<PullRequestObservation | undefined>;
  getReviewState(number: number): Promise<{ readonly decision: "approved" | "changes-requested" | "reviewed" | "unreviewed" }>;
  mergePullRequest(number: number, strategy: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void>;
  /** Closes an open pull request, but only while its head and base still match. */
  closePullRequestIf(number: number, expected: { readonly head: string; readonly base: string }): Promise<boolean>;
}

export interface AutoRunLauncher {
  runAutomated(input: DelegationLaunchInput, signal?: AbortSignal): Promise<AutomatedLaunchOutcome>;
  resumeAutomated?(session: AgentSession, prompt: string, difficulty?: IssueDifficulty, signal?: AbortSignal, completionCommitStartingSha?: string, reviewRange?: string): Promise<AutomatedLaunchOutcome>;
  launchInteractive(input: DelegationLaunchInput, origin: LaunchOrigin): Promise<InteractiveLaunchHandles>;
}

export interface AutoRunTerminals {
  close(terminalId: TerminalId): void;
}

export interface AutoRunStore {
  load(): Promise<AutoRunRecord | undefined>;
  save(record: AutoRunRecord): Promise<void>;
  clear(): Promise<void>;
}

/** One bounded line per phase transition, drained on the user's next message. */
export interface AutoRunNotifier {
  notify(message: string): void;
  alert(message: string, pullRequestUrl?: string): void;
}

/** How the run's own history is recorded, so the panel can show it. */
export interface AutoRunActivitySink {
  runStarted(record: AutoRunRecord, resumed: boolean): void;
  runEnded(record: AutoRunRecord, outcome: RunAttemptOutcome | "succeeded"): void;
  runDiscarded(record: AutoRunRecord): void;
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
  readonly phase: AutoRunPhase | "explore";
  readonly currentIssue: number | undefined;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly waiting: boolean;
  readonly expectedBranch?: string;
  readonly dirtyPaths?: readonly string[];
  readonly currentPullRequest: number | undefined;
}

export type AutoRunStartResult =
  | {
      readonly started: true;
      readonly runId: string;
      readonly reviewMode: boolean;
      readonly exploresBeforeImplement: boolean;
      readonly branchMode: "per-issue" | "single-branch";
      readonly sessionBranch: string;
      readonly sessionBase: string;
      readonly mergesItsOwnPullRequest: boolean;
      readonly issues: readonly FrozenIssue[];
      readonly skipped: readonly SkippedIssue[];
      readonly dependencyCycles: readonly (readonly number[])[];
    }
  | { readonly started: false; readonly reason: string; readonly active?: AutoRunState };

type InspectedAutoRunPreview = Extract<AutoRunDryRunResult, { readonly inspected: true }>;

interface TargetPublication {
  readonly headSha: string;
  readonly unpublishedCommits: number;
}

export type AutoRunPreviewedStartResult = AutoRunStartResult
  | { readonly started: false; readonly reason: string; readonly refreshPreview: true };

/** Terminal for one attempt: how the loop left the run. */
type AttemptEnd = { readonly outcome: RunAttemptOutcome | "succeeded" };

/** A structural mismatch. Distinguished so no concluding side effect follows it. */
class StructuralError extends Error {
  public constructor(public readonly eligibilityReason: string) {
    super(eligibilityReason);
    this.name = "StructuralError";
  }
}

/** The active auto-run worker settled because this attempt was aborted. */
class AutomatedWorkerCancelled extends Error {}

/** What an `address-this` worker left behind, once aboard has accepted it. */
interface ImplementationResult {
  /** The accepted implementation commit: worker-created for AFK, human-created for HITL. */
  readonly sha: string;
  /** Its closing message, used verbatim as a human summary. */
  readonly report: string;
}

function samePreview(left: InspectedAutoRunPreview, right: InspectedAutoRunPreview): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameGitHubPlan(left: InspectedAutoRunPreview, right: InspectedAutoRunPreview): boolean {
  return JSON.stringify({ issues: left.issues, skipped: left.skipped, dependencyCycles: left.dependencyCycles })
    === JSON.stringify({ issues: right.issues, skipped: right.skipped, dependencyCycles: right.dependencyCycles });
}

export class AutoRunEngine {
  #controller: AbortController | undefined;
  #state: AutoRunState | undefined;
  #record: AutoRunRecord | undefined;
  #persisted: AutoRunRecord | undefined;
  #eligibility: RecoveryEligibility | undefined;
  #workspace: RunWorkspace | undefined;
  #loop: Promise<void> = Promise.resolve();
  #wake: (() => void) | undefined;
  #checking: Promise<RecoveryEligibility> | undefined;
  #observationTail: Promise<void> = Promise.resolve();
  #generation = 0;
  readonly #issuePullRequests = new Map<number, number>();
  /** The visible worker terminal a HITL acceptance is expected to happen next to. */
  readonly #pending = new Map<number, TerminalId>();
  readonly #openTerminals = new Set<TerminalId>();
  readonly #now: () => Date;
  readonly #runId: () => string;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #exists: (path: string) => boolean;
  #continuedSession: AgentSession | undefined;

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
  public persisted(): AutoRunRecord | undefined {
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
    return { isolation: { cwd: workspace.root, protectedPaths: workspace.protectedPaths, writableRoots: workspace.writableRoots } };
  }

  public async refresh(): Promise<RecoveryEligibility | undefined> {
    this.repositoryChanged();
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
    if (!this.isActive() && persisted.outcome === undefined) {
      persisted = { ...persisted, updatedAt: this.#now().toISOString(), outcome: { kind: "interrupted" } };
      await this.options.store.save(persisted);
      this.#persisted = persisted;
      this.options.activity?.runEnded(persisted, { kind: "interrupted" });
    }
    let checked;
    try {
      checked = await this.#checkRun(persisted);
    } catch (error) {
      if (generation !== this.#generation) return this.#eligibility ?? { state: "checking" };
      this.options.log?.(`auto-run recovery check unavailable: ${message(error)}`);
      this.#eligibility = { state: "checking" };
      return this.#eligibility;
    }
    const { eligibility, observations } = checked;
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

  /** Git fetch mutates refs, so every active and UI-triggered observation shares one queue. */
  async #checkRun(record: AutoRunRecord): ReturnType<typeof checkRun> {
    const previous = this.#observationTail;
    let release = (): void => undefined;
    this.#observationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await checkRun(record, this.#observationSources(record));
    } finally {
      release();
    }
  }

  public async dryRun(options: { readonly additionalGuideline?: string } = {}): Promise<AutoRunDryRunResult> {
    return this.#dryRun(this.options.settings(), options);
  }

  async #dryRun(
    settings: AutoRunSettings,
    options: { readonly additionalGuideline?: string },
  ): Promise<AutoRunDryRunResult> {
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

    const sessionBase = status.branch ?? defaultBranch;
    let publication: TargetPublication;
    try {
      publication = await this.#targetPublication(sessionBase);
    } catch (error) {
      return { dryRun: true, inspected: false, reason: `the target branch could not be compared with origin (${message(error)})` };
    }

    const plan = planRun((await this.options.github.listImplementableIssues()).candidates);
    const blockers: string[] = [];
    const warnings = publication.unpublishedCommits === 0
      ? []
      : [unpublishedTargetWarning(sessionBase, publication.unpublishedCommits)];
    if (status.branch !== undefined) {
      const branchBlocker = autoRunTargetBranchBlocker(status.branch);
      if (branchBlocker !== undefined) blockers.push(branchBlocker);
    }
    if (status.entries.length > 0 && this.options.workspaces?.isolates() !== true) {
      const paths = status.entries.map((entry) => entry.path);
      blockers.push(`the working tree is not clean: ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? `, and ${paths.length - 20} more` : ""}`);
    }
    const emptyReason = plan.issues.length === 0 ? emptyQueueReason(plan.skipped.length) : undefined;
    if (plan.issues.length > 0) {
      const conflict = settings.branchMode !== "single-branch" ? await this.#findPlanConflict(plan.issues) : undefined;
      if (conflict !== undefined) blockers.push(conflict);
    }

    return {
      dryRun: true,
      inspected: true,
      ready: blockers.length === 0 && emptyReason === undefined,
      blockers,
      warnings,
      emptyReason,
      reviewMode: settings.review,
      exploresBeforeImplement: settings.exploreBeforeImplement,
      branchMode: settings.branchMode ?? "per-issue",
      ...permanentPromptProperty(settings.permanentPrompt),
      ...guidelineProperty(options.additionalGuideline),
      isolatedWorkspace: this.options.workspaces?.isolates() ?? settings.worktree.enabled,
      keepsWorkspace: settings.worktree.keep,
      sessionBranch: "run/<run-id>",
      sessionBase,
      targetHeadSha: publication.headSha,
      unpublishedTargetCommits: publication.unpublishedCommits,
      mergesItsOwnPullRequest: settings.mergeRunPullRequest,
      issues: plan.issues,
      skipped: plan.skipped,
      dependencyCycles: plan.dependencyCycles,
    };
  }

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
    if (plan.issues.length === 0) return { started: false, reason: emptyQueueReason(plan.skipped.length) };
    const returnBranch = await this.options.git.currentBranch() ?? await this.options.git.defaultBranch();
    const branchBlocker = autoRunTargetBranchBlocker(returnBranch);
    if (branchBlocker !== undefined) return { started: false, reason: branchBlocker };
    const conflict = settings.branchMode !== "single-branch" ? await this.#findPlanConflict(plan.issues) : undefined;
    if (conflict !== undefined) return { started: false, reason: conflict };

    let publication: TargetPublication;
    try {
      publication = await this.#targetPublication(returnBranch);
    } catch (error) {
      return { started: false, reason: `the target branch could not be compared with origin (${message(error)})` };
    }
    return this.#startPlan(plan, settings, returnBranch, publication, options);
  }

  /** Validates the visible preview, then freezes that exact issue plan. */
  public async startPreviewed(expected: InspectedAutoRunPreview): Promise<AutoRunPreviewedStartResult> {
    if (this.#state !== undefined) return { started: false, reason: "a run is already active", active: this.#state };
    const existing = await this.options.store.load().catch(() => undefined);
    if (existing !== undefined) {
      return { started: false, reason: "a previous run is still unresolved; resume or discard it first" };
    }

    const settings = this.options.settings();
    const options = guidelineProperty(expected.additionalGuideline);
    const confirmed = await this.#dryRun(settings, options);
    if (!confirmed.inspected) return { started: false, reason: confirmed.reason };
    if (!sameGitHubPlan(expected, confirmed)) {
      return {
        started: false,
        reason: "GitHub issue state changed; use Check Now to refresh the preview before starting",
        refreshPreview: true,
      };
    }
    if (!samePreview(expected, confirmed)) {
      return {
        started: false,
        reason: "the auto-run preview is out of date; use Check Now to refresh it before starting",
        refreshPreview: true,
      };
    }
    if (!expected.ready) {
      return {
        started: false,
        reason: expected.blockers[0] ?? expected.emptyReason ?? "there is nothing ready to run",
      };
    }

    return this.#startPlan(
      { issues: expected.issues as readonly FrozenIssue[], skipped: expected.skipped, dependencyCycles: expected.dependencyCycles },
      settings,
      expected.sessionBase,
      { headSha: expected.targetHeadSha, unpublishedCommits: expected.unpublishedTargetCommits },
      options,
    );
  }

  async #startPlan(
    plan: ReturnType<typeof planRun>,
    settings: AutoRunSettings,
    returnBranch: string,
    publication: TargetPublication,
    options: { readonly additionalGuideline?: string },
  ): Promise<AutoRunStartResult> {
    const runId = this.#runId();
    const isolated = this.options.workspaces?.isolates() ?? settings.worktree.enabled;

    const frozen: FrozenRunSettings = {
      branchMode: settings.branchMode ?? "per-issue",
      review: settings.review,
      exploreBeforeImplement: settings.exploreBeforeImplement,
      issueContextDepth: settings.issueContextDepth,
      mergeStrategy: settings.mergeStrategy,
      mergeRunPullRequest: settings.mergeRunPullRequest,
      worktree: settings.worktree,
      ...(isolated
        ? {
            workspaceRoot: this.options.workspaces?.nextRoot(settings.worktree)
              ?? runWorkspacePath({ workspaceRoot: this.options.workspaceRoot, root: settings.worktree.root }),
          }
        : {}),
      ...permanentPromptProperty(settings.permanentPrompt),
      ...guidelineProperty(options.additionalGuideline),
    };
    const now = this.#now().toISOString();
    const record: AutoRunRecord = {
      version: 1,
      runId,
      startedAt: now,
      updatedAt: now,
      attempt: 1,
      settings: frozen,
      plan: plan.issues,
      progress: Object.fromEntries(plan.issues.map((issue) => [String(issue.number), { state: "pending" } as IssueProgress])),
      sessionBranch: sessionBranchName(runId),
      targetBranch: returnBranch,
      targetHeadSha: publication.headSha,
      ...(publication.unpublishedCommits === 0 ? {} : { unpublishedTargetCommits: publication.unpublishedCommits }),
      branchShas: {},
      currentIssue: undefined,
      checkpoint: "planned",
      reviewedIssues: [],
    };
    await this.options.store.save(record);
    this.#persisted = record;
    if (publication.unpublishedCommits > 0) {
      this.options.notifier.notify(autoRunMessage.unpublishedTarget(returnBranch, publication.unpublishedCommits));
    }

    const afk = plan.issues.filter((issue) => issue.disposition === "afk").length;
    this.options.notifier.notify(autoRunMessage.started(afk, plan.issues.length - afk, frozen.review));
    for (const cycle of plan.dependencyCycles) {
      this.options.notifier.notify(`auto-run: dependency cycle detected among ${cycle.map((number) => `#${number}`).join(", ")}; ordering those issues oldest first.`);
    }
    if (plan.skipped.length > 0) {
      this.options.notifier.notify(`auto-run: ${plan.skipped.length} issue${plan.skipped.length === 1 ? "" : "s"} discarded (not ready to run).`);
    }
    this.options.activity?.runStarted(record, false);
    this.#begin(record);
    return {
      started: true,
      runId,
      reviewMode: frozen.review,
      exploresBeforeImplement: frozen.exploreBeforeImplement,
      branchMode: frozen.branchMode ?? "per-issue",
      sessionBranch: record.sessionBranch,
      sessionBase: record.targetBranch ?? await this.options.git.defaultBranch(),
      mergesItsOwnPullRequest: frozen.mergeRunPullRequest,
      issues: plan.issues,
      skipped: plan.skipped,
      dependencyCycles: plan.dependencyCycles,
    };
  }

  async #findPlanConflict(issues: readonly FrozenIssue[]): Promise<string | undefined> {
    // One ref listing and one pull-request query for the whole plan instead of
    // three process spawns per issue. Issues are still reported in plan order,
    // branch conflict before pull-request conflict.
    const branches = issues.map((issue) => issue.branch);
    const [existing, pullRequests] = await Promise.all([
      this.options.git.existingBranches(branches),
      this.options.github.findPullRequestsByHead !== undefined
        ? this.options.github.findPullRequestsByHead(branches)
        : this.#findPullRequestsIndividually(branches),
    ]);
    for (const issue of issues) {
      if (existing.local.has(issue.branch) || existing.remote.has(issue.branch)) {
        return `${issue.branch} already exists, so aboard cannot prove a run would own it; delete or rename it first`;
      }
      if (pullRequests.has(issue.branch)) {
        return `a pull request already uses ${issue.branch}, so aboard cannot prove a run would own it; delete or rename the branch first`;
      }
    }
    return undefined;
  }

  async #findPullRequestsIndividually(branches: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const found = new Map<string, number>();
    for (const branch of branches) {
      const number = await this.options.github.findPullRequestForBranch(branch);
      if (number !== undefined) found.set(branch, number);
    }
    return found;
  }

  public async resume(options: { readonly continueSession?: AgentSession } = {}): Promise<AutoRunStartResult> {
    if (this.#state !== undefined) return { started: false, reason: "a run is already active", active: this.#state };
    const eligibility = await this.refresh();
    const persisted = this.#persisted;
    if (persisted === undefined) return { started: false, reason: "there is no recorded run to resume" };
    if (eligibility?.state !== "resumable") {
      return { started: false, reason: eligibility?.state === "broken" ? eligibility.reason : "the run's state is still being checked" };
    }
    if (options.continueSession !== undefined) {
      const candidate = continuationSessionFor(persisted, [options.continueSession]);
      if (candidate === undefined || this.options.launcher.resumeAutomated === undefined) {
        return { started: false, reason: "the failed agent session is no longer available to continue" };
      }
      this.#continuedSession = candidate;
    } else {
      this.#continuedSession = undefined;
    }
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
      exploresBeforeImplement: record.settings.exploreBeforeImplement,
      branchMode: record.settings.branchMode ?? "per-issue",
      sessionBranch: record.sessionBranch,
      sessionBase: record.targetBranch ?? await this.options.git.defaultBranch(),
      mergesItsOwnPullRequest: record.settings.mergeRunPullRequest,
      issues: record.plan,
      skipped: [],
      dependencyCycles: [],
    };
  }

  public stop(reason = "stopped by the user"): void {
    if (this.#state === undefined) return;
    this.options.notifier.notify(autoRunMessage.stopped(this.#state.currentIssue, reason));
    this.#cancelled = true;
    this.#controller?.abort();
    this.#wake?.();
  }

  public interrupt(reason = "the extension is shutting down"): void {
    if (this.#state === undefined) return;
    this.options.notifier.notify(autoRunMessage.stopped(this.#state.currentIssue, reason));
    this.#controller?.abort();
    this.#wake?.();
  }

  #cancelled = false;

  /** Wake repository observation after a filesystem, lifecycle, focus, or refresh event. */
  public repositoryChanged(): void { this.#wake?.(); }

  readonly #closedTerminals = new Set<TerminalId>();
  public terminalClosed(terminalId: TerminalId): void {
    this.#closedTerminals.add(terminalId);
    this.repositoryChanged();
  }

  public async settle(): Promise<void> {
    await this.#loop;
  }

  public async discard(behavior?: DiscardBehavior): Promise<DiscardResult> {
    const persisted = this.#persisted ?? await this.options.store.load().catch(() => undefined);
    const chosen = behavior ?? this.options.discardBehavior?.() ?? "record-only";
    if (persisted === undefined) {
      await this.options.store.clear();
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
    const persisted = record ?? this.#persisted;
    if (persisted === undefined) {
      return { behavior, closeTerminals: false, removeWorkspace: false, localBranches: [], remoteBranches: [], pullRequests: [], retained: [] };
    }
    const { observations } = await this.#checkRun(persisted);
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
    let attemptEnd: AttemptEnd | undefined;
    this.#loop = this.#run(controller.signal)
      .then((end) => { attemptEnd = end; })
      .catch((error: unknown) => {
        this.options.log?.(`auto-run failed: ${message(error)}`);
      })
      .finally(async () => {
        this.#controller = undefined;
        await this.#restoreOriginalBranch(homeBranch, attemptEnd).finally(async () => {
          this.#workspace = undefined;
          this.#publish(undefined);
          await this.refresh();
        });
      });
  }

  async #restoreOriginalBranch(branch: string | undefined, end: AttemptEnd | undefined): Promise<void> {
    if (
      branch === undefined
      || this.#workspace?.isolated === true
      || this.#persisted?.currentIssue !== undefined
      || end === undefined
      || (end.outcome !== "succeeded" && end.outcome.kind === "failed")
    ) return;
    try {
      const status = await this.options.git.status();
      if (status.branch === branch) return;
      if (status.entries.length > 0) {
        const current = status.branch ?? "a detached HEAD";
        this.options.notifier.notify(autoRunMessage.returnBlocked(
          branch,
          current,
          status.entries.map((entry) => entry.path),
        ));
        this.options.log?.(`auto-run: not returning to ${branch}; the working tree on ${status.branch ?? "a detached HEAD"} has uncommitted changes`);
        return;
      }
      await this.options.git.checkout(branch);
      this.options.notifier.notify(autoRunMessage.returned(branch));
    } catch (error) {
      this.options.log?.(`auto-run: could not return to ${branch}: ${message(error)}`);
    }
  }


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


  async #run(signal: AbortSignal): Promise<AttemptEnd> {
    let end: AttemptEnd = { outcome: { kind: "interrupted" } };
    try {
      await this.#recoverPendingAction();
      await this.#ensureWorkspace();
      await this.#ensureSessionBranch();
      end = await this.#drive(signal);
    } catch (error) {
      if (error instanceof StructuralError) {
        end = { outcome: { kind: "failed", reason: error.eligibilityReason } };
        return this.#conclude(end, signal, { sideEffects: false });
      }
      end = { outcome: { kind: "failed", reason: message(error) } };
    }
    return this.#conclude(end, signal, { sideEffects: true });
  }

  async #conclude(end: AttemptEnd, signal: AbortSignal, options: { readonly sideEffects: boolean }): Promise<AttemptEnd> {
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
    return final;
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

  async #drive(signal: AbortSignal): Promise<AttemptEnd> {
    while (!signal.aborted) {
      const record = this.#current;
      const issue = remainingIssues(record)[0];
      if (issue === undefined) {
        this.options.notifier.notify(autoRunMessage.complete(completedCount(record), 0));
        return { outcome: "succeeded" };
      }

      await this.#validate();
      const outcome = record.settings.branchMode === "single-branch"
        ? await this.#processSingleBranchIssue(issue, signal)
        : await this.#processIssue(issue, signal);
      if (outcome.kind === "aborted") {
        return { outcome: this.#cancelled ? { kind: "cancelled" } : { kind: "interrupted" } };
      }
      if (outcome.kind === "stopped") return { outcome: { kind: "failed", reason: outcome.reason } };

    }
    return { outcome: this.#cancelled ? { kind: "cancelled" } : { kind: "interrupted" } };
  }

  /** Validates the whole frozen plan before a phase side effect. */
  async #validate(): Promise<RunObservations> {
    const record = this.#current;
    const { eligibility, observations } = await this.#checkRun(record);
    this.#titles = observations.titles;
    if (eligibility.state === "broken") throw new StructuralError(eligibility.reason);
    return observations;
  }


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
      ...(record.settings.workspaceRoot === undefined ? {} : { checkoutRoot: record.settings.workspaceRoot }),
      prepared: record.workspaceCreated === true,
    });
    this.#workspace = workspace;
    if (workspace.isolated) this.options.notifier.notify(autoRunMessage.workspace(workspace.root));
    await this.#advance("workspace-ready", workspace.isolated ? { workspaceCreated: true } : {});
  }

  async #ensureSessionBranch(): Promise<void> {
    const record = this.#current;
    const base = record.targetBranch ?? await this.#git.defaultBranch();
    this.options.notifier.notify(autoRunMessage.session(record.sessionBranch, base));
    // A recovered issue merge is reconciled before session setup.
    if (checkpointReached(record.checkpoint, "session-branch-ready")) return;
    await this.#git.fetch();
    const baseOnRemote = await this.#git.remoteBranchExists(base);
    if (!await this.#git.branchExists(record.sessionBranch)) {
      const localBaseSha = await this.#git.branchSha(base);
      const baseSha = localBaseSha ?? await this.#git.remoteBranchSha(base);
      if (baseSha === undefined) throw new Error(`the base branch ${base} no longer exists`);
      await this.#journal({ kind: "create-branch", branch: record.sessionBranch, base, baseSha });
      await this.#git.createBranch(record.sessionBranch, localBaseSha === undefined ? `origin/${base}` : base);
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

  async #recoverPendingAction(): Promise<void> {
    const record = this.#current;
    const action = record.pendingAction;
    if (action === undefined) return;
    switch (action.kind) {
      case "comment-issue":
        await this.#publishIssueComment(action.issue, action.body);
        return;
      case "close-issue": {
        const issue = record.plan.find((item) => item.number === action.issue);
        if (issue === undefined) throw new StructuralError("unknown issue closure");
        await this.#closeAcceptedIssue(issue, action.prNumber, action.comment);
        return;
      }
      case "cleanup-issue":
        await this.#cleanup(record.sessionBranch, action.branch);
        return;
      case "create-branch": {
        const sha = await this.#git.branchSha(action.branch);
        if (sha !== undefined && sha !== action.baseSha) {
          throw new StructuralError(`${action.branch} was created at an unexpected commit`);
        }
        await this.#settled(sha === action.baseSha ? this.#patchBranchSha(action.branch, sha) : {});
        return;
      }
      case "reset-implementation":
        await this.#completeImplementationReset(action);
        return;
      case "worker-turn": {
        const issue = record.plan.find((item) => item.number === record.currentIssue);
        if (issue === undefined || action.branch !== this.#workingBranch(issue) || await this.#git.currentBranch() !== action.branch) throw new StructuralError("worker recovery does not match its recorded branch");
        const state = await this.#workerState(action.parentSha);
        if (action.outcome === "failed") {
          if (action.completion === "commit" && state.headSha !== action.parentSha) throw new StructuralError("a failed worker's commit cannot be accepted");
          await this.#settled();
          return;
        }
        const progress = issueProgress(record, issue.number);
        if (progress.state !== "current") throw new StructuralError("missing worker recovery progress");
        if (action.outcome === undefined) {
          if (state.headSha === action.parentSha) {
            await this.#settled();
            return;
          }
          // An AFK reviewer commit is mechanically self-describing even if the
          // process result was interrupted before its journal update. Other
          // worker turns cannot be adopted without their recorded outcome.
          if (action.role !== "reviewer" || action.completion !== "commit") {
            throw new StructuralError("worker process success was not recorded; inspect the recovery checkout");
          }
        } else if (action.outcome !== "succeeded") {
          throw new StructuralError("worker process success was not recorded; inspect the recovery checkout");
        }
        if (action.completion === "uncommitted") {
          if (state.headSha !== action.parentSha) throw new StructuralError(`${action.role} committed during a non-committing HITL turn`);
          if (action.role === "reviewer") {
            await this.#settled({
              progress: withProgress(record, issue.number, { ...progress, phase: "await-commit", reviewed: true, hitlReviewCompleted: true }).progress,
              reviewedIssues: [...new Set([...record.reviewedIssues, issue.number])],
            });
          } else {
            await this.#settled({ progress: withProgress(record, issue.number, { ...progress, phase: "await-commit" }).progress });
          }
          return;
        }
        const classified = classifyWorkerResult(action.role === "reviewer" ? "review-this" : "address-this", state);
        if (classified.kind === "rejected") throw new StructuralError(classified.reason);
        if (action.role === "reviewer") {
          await this.#settled({ progress: withProgress(record, issue.number, { ...progress, reviewed: true, reviewedSha: state.headSha }).progress,
            reviewedIssues: [...new Set([...record.reviewedIssues, issue.number])] });
        } else if (issue.disposition === "hitl" && record.settings.review) {
          await this.#settled({ progress: withProgress(record, issue.number, { ...progress, phase: "review", implementerCommitSha: classified.sha }).progress });
        } else await this.#recordImplementation(issue, classified.sha);
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
      case "update-run-pr":
        await this.#publishRunPullRequestText(action);
        return;
      case "merge-issue-pr":
      case "merge-run-pr": {
        const snapshot = await this.options.github.getPullRequest(action.prNumber).catch(() => undefined);
        if (snapshot?.state !== "merged") { await this.#settled(); return; }
        // The merge landed. Re-read the base branch so the record carries the
        // tip the merge produced, which is what later validation compares. A
        // coalesced fetch could hide that tip, so this one bypasses freshness.
        await this.#git.fetch({ fresh: true }).catch(() => undefined);
        const baseSha = await this.#git.remoteBranchSha(action.base).catch(() => undefined);
        if (snapshot.headSha !== action.headSha || snapshot.mergeCommitSha === undefined || baseSha !== snapshot.mergeCommitSha) {
          throw new StructuralError(`pull request #${action.prNumber} merged without producing the recorded base branch`);
        }
        if (action.kind === "merge-issue-pr") {
          await this.#git.checkout(action.base);
          await this.#git.fastForward(action.base);
        }
        if (action.kind === "merge-issue-pr") {
          const issue = record.plan.find((item) => item.branch === action.head);
          if (issue === undefined) throw new StructuralError("unknown merged issue");
          await this.#recordIssueMerge(issue, baseSha);
        } else await this.#save({ ...this.#current, ...this.#patchBranchSha(action.base, baseSha) });
        return;
      }
    }
  }

  #issuePullRequestPatch(issueNumber: number, prNumber: number): Partial<AutoRunRecord> {
    const progress = issueProgress(this.#current, issueNumber);
    if (progress.state !== "current") return {};
    return { progress: withProgress(this.#current, issueNumber, { ...progress, prNumber }).progress };
  }

  async #processSingleBranchIssue(
    issue: FrozenIssue,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "done" } | { readonly kind: "aborted" } | { readonly kind: "stopped"; readonly reason: string }> {
    try {
      const branch = this.#current.sessionBranch;
      let progress = issueProgress(this.#current, issue.number);
      if (await this.#git.currentBranch() !== branch) {
        if (progress.state === "current") throw new StructuralError(`expected checkout on ${branch}`);
        if ((await this.#git.status()).entries.length > 0) throw new StructuralError("cannot resume over uncommitted work");
        await this.#git.checkout(branch);
      }
      if (progress.state !== "current") {
        const beforeSha = await this.#git.headSha(false);
        progress = { state: "current", phase: "implement", beforeSha, expectedBranch: branch };
        await this.#save({ ...withProgress(this.#current, issue.number, progress), checkpoint: "issue", currentIssue: issue.number });
      }

      if (progress.implementationSha === undefined) {
        const implementation = await this.#implement(issue, signal);
        if (signal.aborted) return { kind: "aborted" };
        await this.#comment(issue.number, implementation.report);
      }
      await this.#publishImplementation(issue);
      const prNumber = await this.#ensureCumulativePullRequest();
      progress = issueProgress(this.#current, issue.number);
      if (progress.state !== "current") throw new Error(`issue #${issue.number} lost its current progress`);
      if (progress.prNumber !== prNumber) {
        progress = { ...progress, prNumber };
        await this.#save(withProgress(this.#current, issue.number, progress));
      }

      if (this.#current.settings.review && progress.reviewed !== true) {
        await this.#review(issue, prNumber, signal);
        if (signal.aborted) return { kind: "aborted" };
        const reviewedSha = await this.#git.headSha(false);
        progress = { ...progress, phase: "cleanup", reviewed: true, reviewedSha };
        await this.#save({ ...withProgress(this.#current, issue.number, progress), reviewedIssues: [...new Set([...this.#current.reviewedIssues, issue.number])] });
      }

      progress = issueProgress(this.#current, issue.number);
      if (progress.state !== "current") throw new Error(`issue #${issue.number} lost its current progress`);
      await this.#requireCleanCheckout("address-this", issue);
      progress = { ...progress, phase: "cleanup" };
      await this.#save(withProgress(this.#current, issue.number, progress));
      const closed = await this.#closeSingleBranchIssue(issue, prNumber, progress);
      for (const terminalId of this.#openTerminals) this.#closeSettledTerminal(terminalId);
      await this.#finishIssue(issue, { state: "done", result: "landed", prNumber, issueClosed: closed,
        ...this.#issueRange(issue) });
      await this.#updateCumulativePullRequest(prNumber);
      return { kind: "done" };
    } catch (error) {
      if (error instanceof AutomatedWorkerCancelled) return { kind: "aborted" };
      if (error instanceof StructuralError) throw error;
      return { kind: "stopped", reason: message(error) };
    }
  }

  async #ensureCumulativePullRequest(): Promise<number> {
    const record = this.#current;
    const base = record.targetBranch ?? await this.#git.defaultBranch();
    let number = record.runPullRequest ?? await this.options.github.findOpenPullRequestForBranch(record.sessionBranch);
    if (number === undefined) {
      await this.#journal({ kind: "create-run-pr", head: record.sessionBranch, base });
      number = await this.options.github.createPullRequest({ title: runPullRequestTitle(landedIssues(record)), body: runPullRequestBody(landedIssues(record), record.sessionBranch, base, record.unpublishedTargetCommits ?? 0, "single-branch"), head: record.sessionBranch, base });
      await this.#settled({ runPullRequest: number });
    } else if (record.runPullRequest === undefined) await this.#save({ ...record, runPullRequest: number });
    return number;
  }

  async #updateCumulativePullRequest(number: number): Promise<void> {
    if (this.options.github.updatePullRequest === undefined) return;
    const record = this.#current;
    const base = record.targetBranch ?? await this.#git.defaultBranch();
    const landed = landedIssues(record);
    const input = { title: runPullRequestTitle(landed), body: runPullRequestBody(landed, record.sessionBranch, base, record.unpublishedTargetCommits ?? 0, record.settings.branchMode ?? "per-issue") };
    await this.#journal({ kind: "update-run-pr", prNumber: number, ...input });
    await this.#publishRunPullRequestText({ kind: "update-run-pr", prNumber: number, ...input });
  }

  async #publishRunPullRequestText(action: Extract<PendingAction, { kind: "update-run-pr" }>): Promise<void> {
    await this.#validate();
    const observe = async () => {
      const snapshot = await this.options.github.getPullRequest(action.prNumber);
      if (snapshot === undefined || snapshot.headBranch !== this.#current.sessionBranch || snapshot.baseBranch !== this.#current.targetBranch) throw new StructuralError("run pull request update does not match its recorded branches");
      return snapshot;
    };
    let snapshot = await observe();
    if (snapshot.title !== action.title || snapshot.body !== action.body) {
      if (this.options.github.updatePullRequest === undefined) throw new StructuralError("the recorded run pull request update is unsupported by this GitHub boundary");
      await this.options.github.updatePullRequest(action.prNumber, { title: action.title, body: action.body });
      snapshot = await observe();
      if (snapshot.title !== action.title || snapshot.body !== action.body) throw new Error("run pull request update did not reach its postcondition");
    }
    await this.#settled();
  }

  async #closeSingleBranchIssue(issue: FrozenIssue, prNumber: number, progress: Extract<IssueProgress, { state: "current" }>): Promise<boolean> {
    const end = progress.reviewedSha ?? progress.implementationSha;
    const range = progress.beforeSha !== undefined && end !== undefined ? `${progress.beforeSha.slice(0, 8)}..${end.slice(0, 8)}` : "its recorded commit range";
    return this.#closeAcceptedIssue(issue, prNumber, `Accepted on cumulative run PR #${prNumber}; issue work is ${range} on \`${this.#current.sessionBranch}\`. The work reaches \`${this.#current.targetBranch}\` when that PR merges.`);
  }


  async #processIssue(
    issue: FrozenIssue,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "done" } | { readonly kind: "aborted" } | { readonly kind: "stopped"; readonly reason: string }> {
    let phase: AutoRunPhase = "branch";
    let implementation: ImplementationResult | undefined;
    let previous: string | undefined;
    let repeats = 0;

    const existing = issueProgress(this.#current, issue.number);
    let prNumber = existing.state === "current" ? existing.prNumber : undefined;
    const reviewed = new Set(this.#current.reviewedIssues);

    await this.#save({
      ...this.#current,
      checkpoint: "issue",
      currentIssue: issue.number,
      progress: { ...this.#current.progress, [String(issue.number)]: { ...(existing.state === "current" ? existing : {}), state: "current", phase: existing.state === "current" ? existing.phase : "branch", ...(prNumber === undefined ? {} : { prNumber }) } },
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
        waiting: step.action === "await-commit",
        currentPullRequest: prNumber,
      });
      const progress = issueProgress(this.#current, issue.number);
      await this.#save(withProgress(this.#current, issue.number, {
        ...(progress.state === "current" ? progress : {}),
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
          case "await-commit":
          case "implement": {
            implementation = await this.#implement(issue, signal);
            await this.#comment(issue.number, implementation.report);
            this.options.notifier.notify(autoRunMessage.implemented(issue.number, issue.branch));
            break;
          }
          case "publish": {
            const sha = await this.#publishImplementation(issue);
            const opened = prNumber ?? await this.#openPullRequest(issue, implementation?.report ?? "");
            prNumber = opened;
            this.#attach(issue.number, opened);
            this.options.notifier.notify(autoRunMessage.committed(issue.number, sha.slice(0, 8), opened));
            break;
          }
          case "pr": {
            const opened = await this.#openPullRequest(issue, implementation?.report ?? "");
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
          case "merge": {
            const merged = await this.#merge(issue, step.prNumber);
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
              : { state: "done", result: "landed", prNumber: landed, issueClosed: closed, ...this.#issueRange(issue) });
            return { kind: "done" };
          }
          case "advance":
            await this.#finishIssue(issue, { state: "done", result: "no-changes" });
            return { kind: "done" };
          case "stop":
            return { kind: "stopped", reason: step.reason };
        }
      } catch (error) {
        if (error instanceof AutomatedWorkerCancelled) return { kind: "aborted" };
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
    const progress = issueProgress(this.#current, issue.number);
    const onBranch = status.branch === issue.branch;
    // Independent reads run together; the dependent ones keep their guards.
    const [branchExists, issueSnapshot] = await Promise.all([
      this.#git.branchExists(issue.branch),
      this.options.github.getIssue(issue.number),
    ]);
    const [hasCommit, openPr] = await Promise.all([
      branchExists && onBranch ? this.#hasIssueCommit(issue.branch) : Promise.resolve(false),
      branchExists ? this.options.github.findOpenPullRequestForBranch(issue.branch) : Promise.resolve(undefined),
    ]);
    const prNumber = openPr ?? knownPullRequest;
    let pullRequest: RepositoryFacts["pullRequest"];
    const [snapshot, commitPushed] = await Promise.all([
      prNumber === undefined ? Promise.resolve(undefined) : this.options.github.getPullRequest(prNumber),
      hasCommit ? this.#git.isPushed(issue.branch) : Promise.resolve(false),
    ]);
    if (prNumber !== undefined && snapshot !== undefined) {
      pullRequest = { number: prNumber, state: snapshot.state };
    }
    return {
      currentBranch: status.branch,
      branchExists,
      workingTreeDirty: status.entries.length > 0,
      dirtyPaths: status.entries.map((entry) => entry.path),
      hasCommit,
      ...(progress.state === "current" && progress.implementationSha !== undefined ? { implementationSha: progress.implementationSha } : {}),
      awaitingCommit: progress.state === "current" && progress.phase === "await-commit",
      hitlReviewPending: progress.state === "current" && issue.disposition === "hitl" && this.#current.settings.review
        && progress.implementerCommitSha !== undefined && progress.hitlReviewCompleted !== true,
      commitPushed,
      pullRequest,
      reviewed: reviewed.has(issue.number) || (progress.state === "current" && progress.reviewed === true),
      issueClosed: issueSnapshot?.state === "closed",
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

  #guidance(): {
    readonly permanentPrompt?: string;
    readonly additionalGuideline?: string;
  } {
    return {
      ...permanentPromptProperty(this.#current.settings.permanentPrompt),
      ...guidelineProperty(this.#current.settings.additionalGuideline),
    };
  }

  /**
   * Aboard's own clean-checkout gate. The skills' `UserPromptSubmit` hooks
   * enforce the same rule for manual invocation, but neither is the other's
   * safety boundary.
   */
  async #requireCleanCheckout(role: WorkerRole, issue: FrozenIssue): Promise<void> {
    const status = await this.#git.status();
    if (status.branch !== this.#workingBranch(issue)) throw new StructuralError(`the checkout is on ${status.branch ?? "a detached HEAD"}; expected ${this.#workingBranch(issue)}`);
    if (status.entries.length === 0) return;
    const paths = status.entries.slice(0, 10).map((entry) => entry.path).join(", ");
    throw new Error(
      `${role} needs a completely clean checkout, but ${status.entries.length} path(s) are uncommitted on ${status.branch ?? "a detached HEAD"} for issue #${issue.number}: ${paths}`,
    );
  }

  async #completeImplementationReset(action: Extract<PendingAction, { kind: "reset-implementation" }>): Promise<void> {
    const issue = this.#current.plan.find((item) => item.number === this.#current.currentIssue);
    const progress = issue === undefined ? undefined : issueProgress(this.#current, issue.number);
    if (issue === undefined || progress?.state !== "current" || progress.beforeSha !== action.beforeSha || progress.implementerCommitSha !== action.implementerCommitSha) {
      throw new StructuralError("the recorded HITL implementation reset no longer matches its issue checkpoint");
    }
    const branch = await this.#git.currentBranch();
    if (branch !== action.branch) throw new StructuralError(`the checkout is on ${branch ?? "a detached HEAD"}; expected ${action.branch} for the HITL implementation reset`);
    const head = await this.#git.headSha(false);
    if (head === action.implementerCommitSha) await this.#git.resetMixed(action.beforeSha);
    else if (head !== action.beforeSha) throw new StructuralError("HEAD is on neither side of the recorded HITL implementation reset");
    if (await this.#git.headSha(false) !== action.beforeSha || await this.#git.currentBranch() !== action.branch) {
      throw new StructuralError("the HITL implementation reset did not restore its recorded branch and parent");
    }
    const beforeTreeSha = await this.#git.treeSha(action.beforeSha);
    if (beforeTreeSha === undefined || await this.#git.stagedTreeSha() !== beforeTreeSha) {
      throw new StructuralError("the HITL implementation mixed reset left an unexpected index");
    }
    if (!await this.#git.workingTreeMatchesCommit(action.implementerCommitSha)) {
      throw new StructuralError("the uncommitted HITL review handoff no longer matches the recorded implementation checkpoint");
    }
    await this.#settled({
      progress: withProgress(this.#current, issue.number, { ...progress, phase: "review", resetCompleted: true }).progress,
    });
  }

  async #resetImplementationForReview(issue: FrozenIssue): Promise<void> {
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current" || progress.beforeSha === undefined || progress.implementerCommitSha === undefined) {
      throw new StructuralError("missing HITL implementation checkpoint for review");
    }
    const action = {
      kind: "reset-implementation" as const,
      branch: this.#workingBranch(issue),
      beforeSha: progress.beforeSha,
      implementerCommitSha: progress.implementerCommitSha,
    };
    await this.#journal(action);
    await this.#completeImplementationReset(action);
  }

  /** The branch a worker for this issue is launched on, by branch mode. */
  #workingBranch(issue: FrozenIssue): string {
    return this.#current.settings.branchMode === "single-branch" ? this.#current.sessionBranch : issue.branch;
  }

  /** Reads back exactly what a worker did to the checkout, and nothing else. */
  async #workerState(startingSha: string): Promise<WorkerRepositoryState> {
    const status = await this.#git.status();
    const headSha = await this.#git.headSha(false);
    const moved = headSha !== startingSha;
    const descendsFromStart = !moved || await this.#git.isAncestor(startingSha, headSha);
    const newCommitCount = moved && descendsFromStart ? (await this.#git.aheadBehind(headSha, startingSha)).ahead : 0;
    const [startingTree, headTree] = newCommitCount === 1
      ? await Promise.all([this.#git.treeSha(startingSha), this.#git.treeSha(headSha)])
      : [undefined, undefined];
    return {
      startingSha,
      headSha,
      dirtyPaths: status.entries.map((entry) => entry.path),
      descendsFromStart,
      newCommitCount,
      ...(startingTree === undefined || headTree === undefined ? {} : { commitIsNonEmpty: startingTree !== headTree }),
    };
  }

  async #implement(issue: FrozenIssue, signal: AbortSignal): Promise<ImplementationResult> {
    const previous = issueProgress(this.#current, issue.number);
    if (issue.disposition === "hitl" && this.#current.settings.review && previous.state === "current" && previous.implementerCommitSha !== undefined) {
      if (previous.resetCompleted !== true) await this.#resetImplementationForReview(issue);
      const reset = issueProgress(this.#current, issue.number);
      if (reset.state !== "current") throw new StructuralError("missing HITL review handoff");
      if (reset.hitlReviewCompleted !== true) await this.#reviewHitl(issue, signal);
      return { sha: await this.#awaitCommit(issue, signal), report: "" };
    }
    if (previous.state === "current" && previous.phase === "await-commit") return { sha: await this.#awaitCommit(issue, signal), report: "" };
    const continued = this.#takeContinuation("implementer", issue.number);
    const codebaseContext = continued === undefined && this.#current.settings.exploreBeforeImplement
      ? await this.#explore(issue, signal)
      : undefined;
    if (codebaseContext !== undefined) {
      await this.#validate();
      this.#publishIssuePhase(issue, "implement");
    }
    if (continued === undefined) await this.#requireCleanCheckout("address-this", issue);
    const startingSha = previous.state === "current" && previous.beforeSha !== undefined
      ? previous.beforeSha
      : await this.#git.headSha(false);
    const commitRequired = issue.disposition === "afk" || this.#current.settings.review;
    const prompt = autoRunImplementerPrompt(issue, {
      ...(commitRequired ? { completionCommitStartingSha: startingSha } : {}),
      chrome: issue.chrome === true,
    });
    await this.#save(withProgress(this.#current, issue.number, { ...(previous.state === "current" ? previous : {}), state: "current", phase: "implement", beforeSha: startingSha, expectedBranch: this.#workingBranch(issue) }));
    await this.#journal({ kind: "worker-turn", branch: this.#workingBranch(issue), parentSha: startingSha, role: "implementer", completion: commitRequired ? "commit" : "uncommitted" });
    const outcome = continued !== undefined && this.options.launcher.resumeAutomated !== undefined
      ? await this.options.launcher.resumeAutomated(continued, prompt, issue.difficulty, signal, commitRequired ? startingSha : undefined)
      : await this.options.launcher.runAutomated({
      type: "implementer",
      issues: [issue.number],
      issueContextDepth: this.#current.settings.issueContextDepth,
      ...(codebaseContext === undefined ? {} : { codebaseContext }),
      description: `address issue ${issue.number}`,
      ...(commitRequired ? { completionCommitStartingSha: startingSha } : {}),
      ...(issue.chrome === true ? { chrome: true } : {}),
      ...this.#difficulty(issue),
      prompt,
      ...this.#guidance(),
      ...this.#isolation(),
      }, signal);
    this.#openTerminals.add(outcome.terminalId);
    await this.#remember(issue, outcome, "implementer");
    await this.#journal({ kind: "worker-turn", branch: this.#workingBranch(issue), parentSha: startingSha, role: "implementer", completion: commitRequired ? "commit" : "uncommitted", outcome: outcome.result.outcome });
    if (signal.aborted) {
      this.#closeSettledTerminal(outcome.terminalId);
      throw new AutomatedWorkerCancelled();
    }
    if (outcome.result.outcome === "failed") {
      await this.#markWorkerContinuable();
      throw new Error(`implementer failed: ${outcome.result.failure.type}`);
    }
    if (!commitRequired) {
      const state = await this.#workerState(startingSha);
      if (await this.#git.currentBranch() !== this.#workingBranch(issue) || state.headSha !== startingSha) {
        await this.#markWorkerContinuable();
        throw new Error("the HITL implementer committed or moved history during its non-committing initial turn");
      }
      const progress = issueProgress(this.#current, issue.number);
      if (progress.state !== "current") throw new StructuralError("missing implementation progress");
      await this.#settled({ progress: withProgress(this.#current, issue.number, { ...progress, phase: "await-commit" }).progress });
      return { sha: await this.#awaitCommit(issue, signal), report: outcome.result.lastAssistantMessage.trim() };
    }
    const classified = classifyWorkerResult("address-this", await this.#workerState(startingSha));
    if (classified.kind !== "committed") {
      await this.#markWorkerContinuable();
      throw new Error(classified.kind === "rejected" ? classified.reason : `address-this produced no commit for issue #${issue.number}`);
    }
    if (issue.disposition === "hitl") {
      const progress = issueProgress(this.#current, issue.number);
      if (progress.state !== "current") throw new StructuralError("missing HITL implementation progress");
      await this.#settled({ progress: withProgress(this.#current, issue.number, { ...progress, phase: "review", implementerCommitSha: classified.sha }).progress });
      this.#closeSettledTerminal(outcome.terminalId);
      await this.#resetImplementationForReview(issue);
      await this.#reviewHitl(issue, signal);
      return { sha: await this.#awaitCommit(issue, signal), report: outcome.result.lastAssistantMessage.trim() };
    }
    await this.#recordImplementation(issue, classified.sha);
    await this.#validate();
    this.#closeSettledTerminal(outcome.terminalId);
    return { sha: classified.sha, report: outcome.result.lastAssistantMessage.trim() };
  }

  async #explore(issue: FrozenIssue, signal: AbortSignal): Promise<string> {
    await this.#validate();
    this.#publishIssuePhase(issue, "explore");
    const headSha = await this.#git.headSha(false);
    const outcome = await this.options.launcher.runAutomated({
      type: "Explore",
      issues: [issue.number],
      issueContextDepth: this.#current.settings.issueContextDepth,
      description: `explore issue ${issue.number}`,
      prompt: autoRunExplorePrompt(issue),
      ...this.#guidance(),
      ...this.#isolation(),
    }, signal);
    this.#openTerminals.add(outcome.terminalId);
    await this.#rememberExploration(issue, outcome);
    if (signal.aborted) {
      this.#closeSettledTerminal(outcome.terminalId);
      throw new AutomatedWorkerCancelled();
    }
    if (outcome.result.outcome === "failed") {
      throw new Error(`Explore failed: ${outcome.result.failure.type}`);
    }

    await this.#validate();
    const report = requireExploreReport(outcome.result.lastAssistantMessage);
    await this.#commentExploration(issue.number, headSha, report);
    this.#closeSettledTerminal(outcome.terminalId);
    return report;
  }

  #publishIssuePhase(issue: FrozenIssue, phase: AutoRunState["phase"]): void {
    this.#publish({
      runId: this.#current.runId,
      phase,
      currentIssue: issue.number,
      completedCount: completedCount(this.#current),
      totalCount: this.#current.plan.length,
      waiting: false,
      currentPullRequest: this.#prForIssue(issue.number) ?? this.#current.runPullRequest,
    });
  }

  async #comment(issueNumber: number, summary: string): Promise<void> {
    const body = issueCommentBody(summary);
    if (body === undefined) return;
    await this.#publishIssueComment(issueNumber, body);
  }

  async #commentExploration(issueNumber: number, headSha: string, report: string): Promise<void> {
    await this.#publishIssueComment(issueNumber, explorationCommentBody({
        runId: this.#current.runId,
        issueNumber,
        headSha,
        report,
      }));
  }

  async #publishIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.#validate();
    await this.#journal({ kind: "comment-issue", issue: issueNumber, body });
    const posted = async () => (await this.options.github.getIssue(issueNumber))?.comments?.some((comment) => comment.body === body) === true;
    if (!await posted()) {
      try {
        await this.options.github.addIssueComment(issueNumber, body);
      } catch (error) {
        // Comments are supplementary. Observe an ambiguous write before
        // abandoning it; repository acceptance never depends on this text.
        await posted();
        this.options.log?.(`auto-run could not comment on issue #${issueNumber}: ${message(error)}`);
        await this.#settled();
        return;
      }
      if (!await posted()) throw new Error(`issue #${issueNumber} comment did not reach its postcondition`);
    }
    await this.#settled();
  }

  async #closeIssue(issue: FrozenIssue, prNumber: number): Promise<boolean> {
    return this.#closeAcceptedIssue(issue, prNumber, issueClosedComment(prNumber, this.#current.sessionBranch, this.#current.targetBranch ?? "the original target"));
  }

  async #closeAcceptedIssue(issue: FrozenIssue, prNumber: number, comment: string): Promise<boolean> {
    await this.#validate();
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current" || progress.implementationSha === undefined) throw new StructuralError("cannot close an unaccepted issue");
    if (progress.issueClosed === true) return true;
    await this.#journal({ kind: "close-issue", issue: issue.number, prNumber, comment });
    try {
      if ((await this.options.github.getIssue(issue.number))?.state !== "closed") await this.options.github.closeIssue(issue.number, comment);
    } catch (error) {
      this.options.notifier.notify(autoRunMessage.notClosed(issue.number, message(error)));
      await this.#settled();
      return false;
    }
    if ((await this.options.github.getIssue(issue.number))?.state !== "closed") throw new Error("issue closure did not reach its postcondition");
    await this.#settled({ progress: withProgress(this.#current, issue.number, { ...progress, issueClosed: true }).progress });
    this.options.notifier.notify(autoRunMessage.closed(issue.number));
    return true;
  }

  async #recordIssueMerge(issue: FrozenIssue, sha: string): Promise<void> {
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current") throw new StructuralError("missing merged issue progress");
    if (await this.#git.branchSha(this.#current.sessionBranch) !== sha) throw new StructuralError("session branch did not fast-forward to the issue merge");
    await this.#settled({ ...this.#patchBranchSha(this.#current.sessionBranch, sha),
      progress: withProgress(this.#current, issue.number, { ...progress, phase: "cleanup", mergeSha: sha }).progress });
  }

  #issueRange(issue: FrozenIssue): {
    beforeSha?: string;
    implementerCommitSha?: string;
    resetCompleted?: true;
    hitlReviewCompleted?: true;
    implementationSha?: string;
    reviewedSha?: string;
  } {
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current") return {};
    return {
      ...(progress.beforeSha === undefined ? {} : { beforeSha: progress.beforeSha }),
      ...(progress.implementerCommitSha === undefined ? {} : { implementerCommitSha: progress.implementerCommitSha }),
      ...(progress.resetCompleted === true ? { resetCompleted: true as const } : {}),
      ...(progress.hitlReviewCompleted === true ? { hitlReviewCompleted: true as const } : {}),
      ...(progress.implementationSha === undefined ? {} : { implementationSha: progress.implementationSha }),
      ...(progress.reviewedSha === undefined ? {} : { reviewedSha: progress.reviewedSha }),
    };
  }

  async #recordImplementation(issue: FrozenIssue, sha: string): Promise<void> {
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current") throw new StructuralError("missing implementation progress");
    await this.#settled({ progress: withProgress(this.#current, issue.number, { ...progress, phase: "publish", implementationSha: sha }).progress });
  }

  async #awaitCommit(issue: FrozenIssue, signal: AbortSignal): Promise<string> {
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current" || progress.beforeSha === undefined || progress.expectedBranch !== this.#workingBranch(issue)) throw new StructuralError("missing HITL acceptance boundary");
    this.options.notifier.notify(autoRunMessage.waiting(issue.number));
    const watchers = this.#watchAcceptance();
    try {
      while (!signal.aborted) {
        const state = await this.#workerState(progress.beforeSha);
        const branch = await this.#git.currentBranch();
        let classified = classifyHitlCommit(state, branch, progress.expectedBranch);
        if (classified.kind === "rejected" && classified.recoverable === true) {
          await this.#waitForRepositoryChange(signal);
          const settledState = await this.#workerState(progress.beforeSha);
          classified = classifyHitlCommit(settledState, await this.#git.currentBranch(), progress.expectedBranch);
          if (classified.kind === "rejected" && classified.recoverable === true) throw new Error(classified.reason);
        }
        if (classified.kind === "rejected") throw new StructuralError(classified.reason);
        this.#publish({ runId: this.#current.runId, phase: "await-commit", currentIssue: issue.number, completedCount: completedCount(this.#current), totalCount: this.#current.plan.length, waiting: true, currentPullRequest: undefined,
          expectedBranch: progress.expectedBranch, dirtyPaths: state.dirtyPaths });
        if (classified.kind === "committed") {
          await this.#validate();
          await this.#recordImplementation(issue, classified.sha);
          return classified.sha;
        }
        const terminal = this.#pending.get(issue.number);
        if (terminal !== undefined && this.#closedTerminals.has(terminal)) throw new Error("the HITL terminal closed before an acceptance commit; resume after reviewing the checkout");
        await this.#waitForRepositoryChange(signal);
      }
      throw new AutomatedWorkerCancelled();
    } finally { watchers.forEach((watcher) => watcher.close()); }
  }

  #watchAcceptance(): FSWatcher[] {
    const root = this.#current.settings.workspaceRoot ?? this.options.workspaceRoot;
    if (root === undefined) return [];
    const paths = new Set([root]);
    try {
      const pointer = join(root, ".git");
      const gitDir = statSync(pointer).isDirectory() ? pointer : resolve(root, readFileSync(pointer, "utf8").trim().replace(/^gitdir:\s*/u, ""));
      paths.add(gitDir);
      const common = join(gitDir, "commondir");
      if (existsSync(common)) paths.add(join(resolve(gitDir, readFileSync(common, "utf8").trim()), "refs"));
    } catch { /* The internal timer still observes missing or unavailable paths. */ }
    const watchers: FSWatcher[] = [];
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const changed = (): void => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.repositoryChanged(), 100);
    };
    for (const path of paths) {
      try {
        const watcher = watch(path, { recursive: true }, changed);
        watcher.on("error", () => watcher.close());
        watcher.on("close", () => clearTimeout(debounce));
        watchers.push(watcher);
      } catch { /* Filesystem watching is optional; repository checks remain authoritative. */ }
    }
    return watchers;
  }

  /** Publish only the exact accepted implementation or reviewed ending SHA. */
  async #publishImplementation(issue: FrozenIssue): Promise<string> {
    await this.#validate();
    await this.#requireCleanCheckout("address-this", issue);
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current" || progress.beforeSha === undefined || progress.implementationSha === undefined) throw new StructuralError("no accepted implementation to publish");
    const sha = progress.reviewedSha ?? progress.implementationSha;
    if (await this.#git.headSha(false) !== sha || !await this.#git.isAncestor(progress.beforeSha, sha)) throw new StructuralError("accepted commit range changed before publishing");
    const branch = this.#workingBranch(issue);
    this.#publishIssuePhase(issue, "publish");
    if (await this.#git.remoteBranchSha(branch) !== sha) {
      await this.#journal({ kind: "push", branch, sha });
      await this.#git.push(branch, true);
      if (await this.#git.remoteBranchSha(branch) !== sha) throw new Error("push did not publish the accepted commit");
    }
    await this.#settled(this.#patchBranchSha(branch, sha));
    return sha;
  }

  /** Whether the issue branch carries work the session branch does not, by ancestry alone. */
  async #hasIssueCommit(branch: string): Promise<boolean> {
    try {
      return (await this.#git.aheadBehind(branch, this.#current.sessionBranch)).ahead > 0;
    } catch {
      return false;
    }
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
    await this.#settled(this.#issuePullRequestPatch(issue.number, created));
    return created;
  }

  /**
   * Review accepted work automatically in either disposition.
   */
  async #review(issue: FrozenIssue, prNumber: number, signal: AbortSignal): Promise<void> {
    const baseGuidance = this.#guidance();
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current") throw new StructuralError("missing review progress");
    await this.#save(withProgress(this.#current, issue.number, { ...progress, phase: "review" }));
    this.#publishIssuePhase(issue, "review");
    const exactRange = this.#current.settings.branchMode === "single-branch" && progress.state === "current" && progress.beforeSha !== undefined && progress.implementationSha !== undefined
      ? `${progress.beforeSha}..${progress.implementationSha}`
      : undefined;
    const scope = exactRange === undefined ? undefined : autoRunReviewGuideline(issue.number, exactRange);
    const guidance = scope === undefined ? baseGuidance : {
      ...baseGuidance,
      additionalGuideline: [baseGuidance.additionalGuideline, scope].filter((value) => value !== undefined).join("\n\n"),
    };
    const continued = this.#takeContinuation("reviewer", issue.number);
    if (continued === undefined) await this.#requireCleanCheckout("review-this", issue);
    const startingSha = await this.#git.headSha(false);
    const prompt = autoRunReviewerPrompt(issue, prNumber);
    await this.#journal({ kind: "worker-turn", branch: this.#workingBranch(issue), parentSha: startingSha, role: "reviewer", completion: "commit" });
    const outcome = continued !== undefined && this.options.launcher.resumeAutomated !== undefined
      ? await this.options.launcher.resumeAutomated(continued, prompt, issue.difficulty, signal, startingSha)
      : await this.options.launcher.runAutomated({
      type: "reviewer",
      issues: [issue.number],
      pullRequest: prNumber,
      description: `review pull request ${prNumber}`,
      completionCommitStartingSha: startingSha,
      prompt,
      ...guidance,
      ...this.#difficulty(issue),
      ...this.#isolation(),
      }, signal);
    this.#openTerminals.add(outcome.terminalId);
    await this.#remember(issue, outcome, "reviewer");
    await this.#journal({ kind: "worker-turn", branch: this.#workingBranch(issue), parentSha: startingSha, role: "reviewer", completion: "commit", outcome: outcome.result.outcome });
    if (signal.aborted) {
      this.#closeSettledTerminal(outcome.terminalId);
      throw new AutomatedWorkerCancelled();
    }
    if (outcome.result.outcome === "failed") {
      await this.#markWorkerContinuable();
      throw new Error(`reviewer failed: ${outcome.result.failure.type}`);
    }

    const classified = classifyWorkerResult("review-this", await this.#workerState(startingSha));
    if (classified.kind === "rejected") {
      await this.#markWorkerContinuable();
      throw new Error(classified.reason);
    }
    const reviewedSha = classified.sha;
    const current = issueProgress(this.#current, issue.number);
    if (current.state !== "current") throw new StructuralError("missing review progress");
    await this.#settled({ progress: withProgress(this.#current, issue.number, { ...current, reviewed: true, reviewedSha }).progress,
      reviewedIssues: [...new Set([...this.#current.reviewedIssues, issue.number])] });
    await this.#publishImplementation(issue);
    await this.#validate();
    this.options.notifier.notify(autoRunMessage.reviewed(issue.number, classified.sha));
    this.#closeSettledTerminal(outcome.terminalId);
  }

  async #reviewHitl(issue: FrozenIssue, signal: AbortSignal): Promise<void> {
    const progress = issueProgress(this.#current, issue.number);
    if (progress.state !== "current" || progress.beforeSha === undefined || progress.implementerCommitSha === undefined || progress.resetCompleted !== true) {
      throw new StructuralError("missing uncommitted HITL review handoff");
    }
    const exactRange = `${progress.beforeSha}..${progress.implementerCommitSha}`;
    const continued = this.#takeContinuation("reviewer", issue.number);
    const status = await this.#git.status();
    const startingSha = await this.#git.headSha(false);
    if (status.branch !== this.#workingBranch(issue) || startingSha !== progress.beforeSha || (continued === undefined && !await this.#git.workingTreeMatchesCommit(progress.implementerCommitSha))) {
      throw new StructuralError("the HITL reviewer handoff no longer matches its recorded implementation checkpoint");
    }
    const prompt = autoRunHitlReviewerPrompt(issue, exactRange);
    await this.#save(withProgress(this.#current, issue.number, { ...progress, phase: "review" }));
    this.#publishIssuePhase(issue, "review");
    await this.#journal({ kind: "worker-turn", branch: this.#workingBranch(issue), parentSha: startingSha, role: "reviewer", completion: "uncommitted" });
    const outcome = continued !== undefined && this.options.launcher.resumeAutomated !== undefined
      ? await this.options.launcher.resumeAutomated(continued, prompt, issue.difficulty, signal, undefined, exactRange)
      : await this.options.launcher.runAutomated({
          type: "reviewer",
          issues: [issue.number],
          description: `review issue ${issue.number} before acceptance`,
          reviewRange: exactRange,
          prompt,
          ...this.#guidance(),
          ...this.#difficulty(issue),
          ...this.#isolation(),
        }, signal);
    this.#openTerminals.add(outcome.terminalId);
    await this.#remember(issue, outcome, "reviewer");
    await this.#journal({ kind: "worker-turn", branch: this.#workingBranch(issue), parentSha: startingSha, role: "reviewer", completion: "uncommitted", outcome: outcome.result.outcome });
    if (signal.aborted) throw new AutomatedWorkerCancelled();
    if (outcome.result.outcome === "failed") {
      await this.#markWorkerContinuable();
      throw new Error(`reviewer failed: ${outcome.result.failure.type}`);
    }
    const after = await this.#git.status();
    if (after.branch !== this.#workingBranch(issue) || await this.#git.headSha(false) !== progress.beforeSha) {
      await this.#markWorkerContinuable();
      throw new Error("the HITL reviewer committed, changed branches, or rewrote history during its non-committing turn");
    }
    const current = issueProgress(this.#current, issue.number);
    if (current.state !== "current") throw new StructuralError("missing HITL reviewer progress");
    await this.#settled({
      progress: withProgress(this.#current, issue.number, { ...current, phase: "await-commit", reviewed: true, hitlReviewCompleted: true }).progress,
      reviewedIssues: [...new Set([...this.#current.reviewedIssues, issue.number])],
    });
  }

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
          throw new Error(`merging PR #${prNumber} failed (${message(error)}). Resolve the repository integration policy and resume Auto Run.`);
        }
      }
      await this.#git.fetch({ fresh: true }).catch(() => undefined);
      const baseSha = await this.#git.remoteBranchSha(base).catch(() => undefined);
      const after = await this.options.github.getPullRequest(prNumber).catch(() => undefined);
      if (baseSha === undefined || after?.headSha !== headSha || after.mergeCommitSha === undefined || baseSha !== after.mergeCommitSha) {
        throw new StructuralError(`pull request #${prNumber} merged without producing the recorded base branch`);
      }
      await this.#git.checkout(base);
      await this.#git.fastForward(base);
      await this.#recordIssueMerge(issue, baseSha);
    }
    this.options.notifier.notify(autoRunMessage.merged(issue.number, base));
    this.#issuePullRequests.delete(issue.number);
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
    const issue = this.#current.plan.find((item) => item.branch === issueBranch);
    const expectedSha = issueBranch === undefined ? undefined : this.#current.branchShas[issueBranch];
    if (issue !== undefined && expectedSha !== undefined) {
      await this.#validate();
      if ((await this.#git.status()).entries.length > 0) throw new StructuralError("uncommitted changes prevent issue cleanup");
      await this.#journal({ kind: "cleanup-issue", issue: issue.number, branch: issue.branch, sha: expectedSha });
      await this.#git.checkout(sessionBranch);
      await this.#git.deleteBranchAt(issue.branch, expectedSha);
      await this.#git.deleteRemoteBranchAt(issue.branch, expectedSha);
      if (await this.#git.branchSha(issue.branch) !== undefined || await this.#git.remoteBranchSha(issue.branch) !== undefined) throw new StructuralError("issue branch cleanup did not reach its postcondition");
      await this.#settled();
    }
    for (const terminalId of this.#openTerminals) this.#closeSettledTerminal(terminalId);
  }

  #closeSettledTerminal(terminalId: TerminalId): void {
    try {
      this.options.terminals.close(terminalId);
      this.#openTerminals.delete(terminalId);
    } catch {
      // Keep it owned so issue or discard cleanup can retry.
    }
  }

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
      const targetStillUnpublished = await this.#targetStillUnpublished(record, base);
      let prNumber = record.runPullRequest ?? await this.options.github.findOpenPullRequestForBranch(record.sessionBranch);
      if (prNumber === undefined) {
        await this.#journal({ kind: "create-run-pr", head: record.sessionBranch, base });
        prNumber = await this.options.github.createPullRequest({
          title: runPullRequestTitle(landed),
          body: runPullRequestBody(
            landed,
            record.sessionBranch,
            base,
            targetStillUnpublished ? record.unpublishedTargetCommits : 0,
            record.settings.branchMode ?? "per-issue",
          ),
          head: record.sessionBranch,
          base,
        });
        await this.#settled({ runPullRequest: prNumber });
      } else if (record.runPullRequest !== prNumber) {
        await this.#save({ ...this.#current, runPullRequest: prNumber });
      }
      if (this.#current.pendingAction?.kind !== "merge-run-pr") await this.#updateCumulativePullRequest(prNumber);
      this.options.notifier.notify(autoRunMessage.runOpened(prNumber, base, landed.length));
      if (targetStillUnpublished && record.unpublishedTargetCommits !== undefined) {
        this.options.notifier.notify(autoRunMessage.unpublishedTarget(base, record.unpublishedTargetCommits));
      }
      const snapshot = await this.options.github.getPullRequest(prNumber);
      // Only a completed run may land its batch on the user's branch. Failed,
      // paused, and interrupted attempts retain their partial PR for recovery
      // or inspection, even when automatic run-PR merging was enabled.
      if (end.outcome !== "succeeded" || signal.aborted) {
        const reason = end.outcome !== "succeeded" && end.outcome.kind === "failed"
          ? `the run stopped: ${end.outcome.reason}`
          : "the run did not complete";
        this.options.notifier.alert(autoRunMessage.runParked(prNumber, base, reason), snapshot?.url);
        return end;
      }
      if (!record.settings.mergeRunPullRequest) {
        this.options.notifier.alert(autoRunMessage.runWaiting(prNumber, base), snapshot?.url);
        return end;
      }
      if (targetStillUnpublished && record.settings.mergeStrategy !== "merge") {
        this.options.notifier.alert(autoRunMessage.unsafeRunMerge(prNumber, base, record.settings.mergeStrategy), snapshot?.url);
        return failIfSucceeded(end, `the run's pull request #${prNumber} needs the unpublished commits on ${base} pushed before a ${record.settings.mergeStrategy} merge`);
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
    await this.#git.fetch({ fresh: true }).catch(() => undefined);
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
    if (status.branch !== undefined) {
      const branchBlocker = autoRunTargetBranchBlocker(status.branch);
      if (branchBlocker !== undefined) return branchBlocker;
    }
    return undefined;
  }

  async #targetPublication(base: string): Promise<TargetPublication> {
    await this.options.git.fetch();
    const headSha = await this.options.git.branchSha(base) ?? await this.options.git.headSha(false);
    if (headSha === undefined) throw new Error(`the local target branch ${base} does not exist`);
    const remoteSha = await this.options.git.remoteBranchSha(base);
    if (remoteSha === undefined) return { headSha, unpublishedCommits: 0 };
    const { ahead } = await this.options.git.aheadBehind(base, `origin/${base}`);
    return { headSha, unpublishedCommits: ahead };
  }

  async #targetStillUnpublished(record: AutoRunRecord, base: string): Promise<boolean> {
    if (record.unpublishedTargetCommits === undefined || record.targetHeadSha === undefined) return false;
    try {
      await this.#git.fetch({ fresh: true });
      const remoteSha = await this.#git.remoteBranchSha(base);
      return remoteSha === undefined || !await this.#git.isAncestor(record.targetHeadSha, remoteSha);
    } catch (error) {
      this.options.log?.(`auto-run could not verify whether ${base} contains its starting tip: ${message(error)}`);
      return true;
    }
  }

  async #checkGitHubAuthentication(): Promise<string | undefined> {
    try {
      await this.options.github.checkAuthentication();
      return undefined;
    } catch (error) {
      return `GitHub CLI cannot authenticate to this repository; run gh auth status and gh auth login if needed (${message(error)})`;
    }
  }

  async #remember(issue: FrozenIssue, outcome: AutomatedLaunchOutcome, type: "implementer" | "reviewer"): Promise<void> {
    this.#pending.set(issue.number, outcome.terminalId);
    await this.#save({ ...this.#current, workerSession: {
      agentId: outcome.agentId,
      sessionId: outcome.sessionId,
      type,
      issueNumber: issue.number,
    } });
  }

  async #rememberExploration(issue: FrozenIssue, outcome: AutomatedLaunchOutcome): Promise<void> {
    await this.#save({ ...this.#current, workerSession: {
      agentId: outcome.agentId,
      sessionId: outcome.sessionId,
      type: "Explore",
      issueNumber: issue.number,
    } });
  }

  #takeContinuation(type: "implementer" | "reviewer", issueNumber: number): AgentSession | undefined {
    const session = this.#continuedSession;
    if (session?.identity.type !== type || session.issueNumbers?.includes(issueNumber) !== true) return undefined;
    this.#continuedSession = undefined;
    return session;
  }

  async #markWorkerContinuable(): Promise<void> {
    const workerSession = this.#current.workerSession;
    if (workerSession === undefined || workerSession.continuable === true) return;
    await this.#save({ ...this.#current, workerSession: { ...workerSession, continuable: true } });
  }

  #attach(issueNumber: number, prNumber: number | undefined): void {
    if (prNumber !== undefined) this.#issuePullRequests.set(issueNumber, prNumber);
  }

  #prForIssue(issueNumber: number): number | undefined {
    return this.#issuePullRequests.get(issueNumber);
  }

  async #waitForRepositoryChange(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => { if (!settled) { settled = true; this.#wake = undefined; resolve(); } };
      this.#wake = finish;
      void this.#sleep(1_000, signal).then(finish, finish);
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

/** Finds the exact ended worker recorded by a failed run, if it is still in the fleet. */
export function continuationSessionFor(
  record: AutoRunRecord,
  sessions: readonly AgentSession[],
): AgentSession | undefined {
  if (record.outcome?.kind !== "failed" || record.workerSession?.continuable !== true || record.currentIssue === undefined) return undefined;
  const progress = issueProgress(record, record.currentIssue);
  if (progress.state !== "current") return undefined;
  const expectedType = progress.phase === "implement"
    ? "implementer"
    : progress.phase === "review" ? "reviewer" : undefined;
  if (expectedType === undefined || record.workerSession.type !== expectedType || record.workerSession.issueNumber !== record.currentIssue) return undefined;
  return sessions.find((session) =>
    session.identity.agentId === record.workerSession?.agentId
    && session.sessionId === record.workerSession.sessionId
    && session.identity.type === expectedType
    && session.autoRunRestricted === true
    && (session.lifecycle.status === "completed" || session.lifecycle.status === "failed")
    && session.issueNumbers?.includes(record.currentIssue!) === true
    && session.cwd === record.settings.workspaceRoot
  );
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  if (!(error instanceof GitBoundaryError) && !(error instanceof GitHubBoundaryError)) return error.message;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("stderr" in details)) return error.message;
  const stderr = (details as { readonly stderr?: unknown }).stderr;
  if (typeof stderr !== "string") return error.message;
  const firstLine = stderr.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0);
  if (firstLine === undefined) return error.message;
  // Git/GitHub diagnostics explain lookup and network failures, but a remote
  // URL may contain credentials. Keep the diagnostic while dropping whole URLs.
  return `${error.message}: ${firstLine.replace(/\b(?:https?|ssh):\/\/\S+/giu, "<remote>")}`;
}

function guidelineProperty(value: string | undefined): { readonly additionalGuideline?: string } {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? {} : { additionalGuideline: trimmed };
}

function permanentPromptProperty(value: string | undefined): { readonly permanentPrompt?: string } {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? {} : { permanentPrompt: trimmed };
}

function emptyQueueReason(discarded: number): string {
  return discarded === 0
    ? "no open issue is labelled [AI]-afk or [AI]-hitl"
    : `no open issue is labelled [AI]-afk or [AI]-hitl (${discarded} discarded)`;
}
