/**
 * The auto-run driver (`AGENTS.md`).
 *
 * The extension owns the loop; agents only produce content. Every git and GitHub
 * side effect below is performed here, never by an agent, so a branch name, a
 * commit message, a PR title and its `Closes #N` trailer are correct by
 * construction and recoverable after a crash. The phase decisions live in the
 * pure reducer; this module supplies the observed facts and performs the effects.
 */

import {
  autoRunMessage,
  branchName,
  commitSubject,
  issueClosedComment,
  issueCommentBody,
  nextStep,
  pullRequestBody,
  runPullRequestBody,
  runPullRequestTitle,
  selectIssues,
  sessionBranchName,
  type AutoRunDryRunResult,
  type AutoRunPhase,
  type AutoRunRecord,
  type AutoRunSettings,
  type CandidateIssue,
  type LandedIssue,
  type PlannedIssue,
  type RepositoryFacts,
  type SkippedIssue,
} from "../domain/auto-run.js";
import type { AgentId, SessionId, TerminalId } from "../domain/contracts.js";
import type { LaunchOrigin } from "../domain/lease.js";
import type { GitClient } from "../git/client.js";
import type { AutomatedLaunchOutcome, DelegationLaunchInput, InteractiveLaunchHandles, LaunchIsolation } from "../bridge/delegation.js";
import type { RunWorkspace, RunWorkspaceOutcome, RunWorkspaceProvider } from "./worktree.js";
import type { IssueDifficulty } from "../shared/labels.js";

/**
 * A pull request as the run observes it. `mergeable` is carried because a merge
 * that fails has many causes and only one of them — a conflict — is something
 * the run can act on rather than surrender to.
 */
export interface PullRequestObservation {
  readonly state: "open" | "closed" | "merged";
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
  readonly url: string;
}

/** The GitHub surface the engine needs, narrowed so tests can fake it whole. */
export interface AutoRunGitHub {
  /** Proves that gh can authenticate to and resolve the workspace repository. */
  checkAuthentication(): Promise<void>;
  /**
   * Every open issue and its inferred dependencies — the complete graph this
   * run drains, regardless of which spec (if any) an issue belongs to.
   */
  listImplementableIssues(): Promise<{
    readonly candidates: readonly CandidateIssue[];
  }>;
  getIssue(number: number): Promise<{ readonly state: "open" | "closed" } | undefined>;
  addIssueComment(number: number, body: string): Promise<void>;
  closeIssue(number: number, comment: string): Promise<void>;
  createPullRequest(input: { readonly title: string; readonly body: string; readonly head: string; readonly base: string }): Promise<number>;
  findOpenPullRequestForBranch(branch: string): Promise<number | undefined>;
  getPullRequest(number: number): Promise<PullRequestObservation | undefined>;
  getReviewState(number: number): Promise<{ readonly decision: "approved" | "changes-requested" | "reviewed" | "unreviewed" }>;
  mergePullRequest(number: number, strategy: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void>;
}

export interface AutoRunLauncher {
  runAutomated(input: DelegationLaunchInput, signal?: AbortSignal): Promise<AutomatedLaunchOutcome>;
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
  /**
   * Something is waiting on the user's hands. Queued progress reaches whoever
   * next talks to the Manager, which is the wrong channel for a run that has
   * stopped or parked: the user may not be talking to the Manager at all, and
   * the status bar the run owned is gone. An alert is shown immediately.
   */
  alert(message: string, pullRequestUrl?: string): void;
}

/** Who owns an open pull request, so `review_pr` can reopen that session. */
export interface PullRequestOwner {
  readonly prNumber: number;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: TerminalId;
  readonly type: "implementer" | "pr-doctor-afk" | "pr-doctor-hitl";
  readonly issueNumber: number;
  /** The tier the session was launched under, so `review_pr` resumes it as it started. */
  readonly difficulty?: IssueDifficulty;
  /**
   * Where the session ran, when the run had a checkout of its own. `review_pr`
   * resumes the conversation, and Claude Code files a transcript under the
   * directory its session ran in.
   */
  readonly cwd?: string;
}

export interface AutoRunEngineOptions {
  /** git in the user's own checkout. Only the workspace provider uses it directly. */
  readonly git: GitClient;
  /**
   * Where this run works. Absent means the workspace itself, which is the
   * historical behavior and what every in-place run still does.
   */
  readonly workspaces?: RunWorkspaceProvider;
  readonly github: AutoRunGitHub;
  readonly launcher: AutoRunLauncher;
  readonly terminals: AutoRunTerminals;
  readonly store: AutoRunStore;
  readonly notifier: AutoRunNotifier;
  readonly settings: () => AutoRunSettings;
  readonly log?: (message: string) => void;
  readonly onStateChange?: (state: AutoRunState | undefined) => void;
  readonly now?: () => Date;
  readonly runIdFactory?: () => string;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface AutoRunState {
  readonly runId: string;
  readonly phase: AutoRunPhase;
  readonly currentIssue: number | undefined;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly waiting: boolean;
  readonly chromeEnabled: boolean;
  /**
   * The pull request the current issue is parked on. Published so a Manager
   * that joins mid-run can name what the user has to merge without asking
   * GitHub which pull request the run means.
   */
  readonly currentPullRequest: number | undefined;
}

export type AutoRunStartResult =
  | {
      readonly started: true;
      readonly runId: string;
      readonly reviewMode: boolean;
      readonly chromeEnabled: boolean;
      /** The one branch this run's issues merge into. */
      readonly sessionBranch: string;
      /** Where the session branch's pull request will target when the run ends. */
      readonly sessionBase: string;
      readonly mergesItsOwnPullRequest: boolean;
      readonly issues: readonly PlannedIssue[];
      readonly skipped: readonly SkippedIssue[];
      readonly dependencyCycles: readonly (readonly number[])[];
    }
  | { readonly started: false; readonly reason: string; readonly active?: AutoRunState };

/**
 * The run's own branch and where it goes. Held for the whole run rather than
 * recomputed per issue: the branch is derived from the run id and the base from
 * the branch the user was on, and both must stay fixed even if the user moves
 * HEAD while the run is in flight.
 */
interface RunSession {
  readonly branch: string;
  readonly base: string;
  /** Issues whose pull request merged into `branch`, in the order they landed. */
  readonly landed: LandedIssue[];
}

export class AutoRunEngine {
  #controller: AbortController | undefined;
  #state: AutoRunState | undefined;
  /**
   * The checkout the current run works in. Held rather than threaded through
   * every phase because a run is single-flight — `start` refuses a second one —
   * and because the end-of-run branch restore, which happens after `#run` has
   * returned, needs to know whether HEAD was ever moved at all.
   */
  #workspace: RunWorkspace | undefined;
  #loop: Promise<void> = Promise.resolve();
  #wake: (() => void) | undefined;
  readonly #owners = new Map<number, PullRequestOwner>();
  readonly #pending = new Map<number, Omit<PullRequestOwner, "prNumber" | "issueNumber">>();
  readonly #openTerminals = new Set<TerminalId>();
  readonly #now: () => Date;
  readonly #runId: () => string;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  public constructor(private readonly options: AutoRunEngineOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#runId = options.runIdFactory ?? (() => `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    this.#sleep = options.sleep ?? defaultSleep;
  }

  public state(): AutoRunState | undefined {
    return this.#state;
  }

  /**
   * git in the checkout this run works in. Before a workspace is resolved — the
   * preconditions, and the branch the user was on — it is the user's own, which
   * is exactly what those two questions are about.
   */
  get #git(): GitClient {
    return this.#workspace?.git ?? this.options.git;
  }

  /** What an isolated run's launches carry; nothing for a run working in place. */
  #isolation(): { readonly isolation?: LaunchIsolation } {
    const workspace = this.#workspace;
    if (workspace === undefined || !workspace.isolated) return {};
    return { isolation: { cwd: workspace.root, denyTools: workspace.denyTools } };
  }

  /** The same directory, recorded against the session so it can be reopened. */
  #ownerCwd(): { readonly cwd?: string } {
    const isolation = this.#isolation().isolation;
    return isolation === undefined ? {} : { cwd: isolation.cwd };
  }

  /** The owning agent for an open pull request, or `undefined` if unknown. */
  public owner(prNumber: number): PullRequestOwner | undefined {
    return this.#owners.get(prNumber);
  }

  /**
   * Inspects exactly the inputs a new run uses without reserving an id or
   * performing any write. A dirty in-place checkout is reported as a blocker
   * after the GitHub queue is read, so `/auto --dry` remains useful for planning
   * even when `/auto` would currently refuse to start.
   */
  public async dryRun(options: { readonly chrome?: boolean; readonly additionalGuideline?: string } = {}): Promise<AutoRunDryRunResult> {
    if (this.#state !== undefined) {
      return { dryRun: true, inspected: false, reason: "a run is already active" };
    }

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

    const selection = selectIssues((await this.options.github.listImplementableIssues()).candidates);
    const settings = this.options.settings();
    const blockers: string[] = [];
    if (status.entries.length > 0 && this.options.workspaces?.isolates() !== true) {
      const paths = status.entries.map((entry) => entry.path);
      blockers.push(`the working tree is not clean: ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? `, and ${paths.length - 20} more` : ""}`);
    }
    if (selection.issues.length === 0) blockers.push(emptyQueueReason(selection.skipped));

    return {
      dryRun: true,
      inspected: true,
      ready: blockers.length === 0,
      blockers,
      reviewMode: settings.review,
      pauseAfterHitl: settings.pauseAfterHitl,
      chromeEnabled: options.chrome === true,
      ...guidelineProperty(options.additionalGuideline),
      isolatedWorkspace: this.options.workspaces?.isolates() ?? settings.worktree.enabled,
      keepsWorkspace: settings.worktree.keep,
      sessionBranch: "aboard/run/<run-id>",
      sessionBase: status.branch ?? defaultBranch,
      mergesItsOwnPullRequest: settings.mergeRunPullRequest,
      issues: selection.issues,
      skipped: selection.skipped,
      dependencyCycles: selection.dependencyCycles,
    };
  }

  /**
   * Starts a run. Returns as soon as the plan is resolved: a multi-issue run
   * routinely outlasts any single command, and the run must outlive the
   * Manager that triggered it.
   */
  public async start(options: { readonly chrome?: boolean; readonly additionalGuideline?: string } = {}): Promise<AutoRunStartResult> {
    if (this.#state !== undefined) {
      return { started: false, reason: "a run is already active", active: this.#state };
    }
    const settings = this.options.settings();
    const precondition = await this.#checkPreconditions();
    if (precondition !== undefined) return { started: false, reason: precondition };

    const queue = await this.options.github.listImplementableIssues();
    const selection = selectIssues(queue.candidates);
    if (selection.issues.length === 0) return { started: false, reason: emptyQueueReason(selection.skipped) };
    // Where the user was when the run took over. Read here — after the
    // clean-tree precondition, before the first branch phase moves HEAD — so the
    // end-of-run restore targets the branch the run actually displaced. A
    // detached HEAD records `undefined` and the restore is skipped.
    const returnBranch = await this.options.git.currentBranch();

    const record: AutoRunRecord = {
      version: 1,
      runId: this.#runId(),
      issueNumbers: selection.issues.map((issue) => issue.number),
      currentIssue: selection.issues[0]?.number,
      phase: "branch",
      branch: selection.issues[0]?.branch,
      prNumber: undefined,
      reviewMode: settings.review,
      chromeEnabled: options.chrome === true,
      ...guidelineProperty(options.additionalGuideline),
      returnBranch,
      reviewedIssues: [],
      startedAt: this.#now().toISOString(),
    };
    await this.options.store.save(record);
    // Reported with the plan: where this run's work will collect, and which
    // branch it will ask to merge into, are the two facts the user is agreeing
    // to when they start it.
    const session = await this.#resolveSession(record);
    const afk = selection.issues.filter((issue) => issue.disposition === "afk").length;
    this.options.notifier.notify(autoRunMessage.started(afk, selection.issues.length - afk, settings.review, record.chromeEnabled === true));
    for (const cycle of selection.dependencyCycles) {
      this.options.notifier.notify(
        `auto-run: dependency cycle detected among ${cycle.map((number) => `#${number}`).join(", ")}; ordering those issues oldest first.`,
      );
    }
    for (const skipped of selection.skipped) {
      this.options.notifier.notify(`auto-run: issue #${skipped.number} skipped (${skipped.reason}).`);
    }

    this.#begin(record);
    return {
      started: true,
      runId: record.runId,
      reviewMode: settings.review,
      chromeEnabled: record.chromeEnabled === true,
      sessionBranch: session.branch,
      sessionBase: session.base,
      mergesItsOwnPullRequest: settings.mergeRunPullRequest,
      issues: selection.issues,
      skipped: selection.skipped,
      dependencyCycles: selection.dependencyCycles,
    };
  }

  /**
   * Resumes a persisted run. The record is a hint: every fact is re-derived from
   * git and GitHub, and the reducer re-enters at the first unsatisfied
   * postcondition. Never called automatically — activation offers
   * Resume/Discard and does nothing until answered.
   */
  public async resume(record: AutoRunRecord): Promise<AutoRunStartResult> {
    if (this.#state !== undefined) {
      return { started: false, reason: "a run is already active", active: this.#state };
    }
    const precondition = await this.#checkResumePreconditions();
    if (precondition !== undefined) return { started: false, reason: precondition };
    const selection = selectIssues((await this.options.github.listImplementableIssues()).candidates);
    const session = await this.#resolveSession(record);
    this.#begin(record);
    return {
      started: true,
      runId: record.runId,
      reviewMode: record.reviewMode,
      chromeEnabled: record.chromeEnabled === true,
      sessionBranch: session.branch,
      sessionBase: session.base,
      mergesItsOwnPullRequest: this.options.settings().mergeRunPullRequest,
      issues: selection.issues,
      skipped: selection.skipped,
      dependencyCycles: selection.dependencyCycles,
    };
  }

  /**
   * Stops the run. A pause with no resume promise, not an undo: the current
   * agent's terminal is left open and nothing is rolled back.
   */
  public stop(reason = "stopped by the user"): void {
    if (this.#state === undefined) return;
    this.options.notifier.notify(autoRunMessage.stopped(this.#state.currentIssue, reason));
    this.#controller?.abort();
    this.#wake?.();
  }

  /** "Continue now": short-circuits the HITL wait's poll interval. */
  public continueNow(): void {
    this.#wake?.();
  }

  /** Awaits the loop, so deactivation does not tear the extension down mid-phase. */
  public async settle(): Promise<void> {
    await this.#loop;
  }

  #begin(record: AutoRunRecord): void {
    const controller = new AbortController();
    this.#controller = controller;
    // All exits below carry the branch the user was on when the run started, so
    // however the run ends it leaves the checkout where it found it.
    const homeBranch = record.returnBranch;
    this.#publish({
      runId: record.runId,
      phase: record.phase,
      currentIssue: record.currentIssue,
      completedCount: 0,
      totalCount: record.issueNumbers.length,
      waiting: false,
      chromeEnabled: record.chromeEnabled === true,
      currentPullRequest: record.prNumber,
    });
    this.#loop = this.#run(record, controller.signal).catch((error: unknown) => {
      this.options.log?.(`auto-run failed: ${message(error)}`);
      this.options.notifier.alert(autoRunMessage.stopped(this.#state?.currentIssue, message(error)));
    }).finally(() => {
      this.#controller = undefined;
      void this.#restoreOriginalBranch(homeBranch).finally(() => {
        // Cleared only after the restore, which asks whether the run ever moved
        // the user's HEAD in the first place.
        this.#workspace = undefined;
        this.#publish(undefined);
      });
    });
  }

  /**
   * Returns the checkout to the branch the user was on when the run started.
   * Best-effort and quiet on failure: the run's outcome stands on its own, and
   * a user who moved HEAD themselves mid-run wins over the restore — the only
   * guard needed is not checking out over uncommitted work, which switches
   * silently and strands the user on the wrong branch about it.
   *
   * A run with its own checkout has nothing to restore: it never touched the
   * user's HEAD, and checking it out here would be the one moment such a run
   * moved a branch the user is standing on.
   */
  async #restoreOriginalBranch(branch: string | undefined): Promise<void> {
    if (branch === undefined || this.#workspace?.isolated === true) return;
    try {
      const status = await this.options.git.status();
      if (status.branch === branch) return;
      if (status.entries.length > 0) {
        this.options.log?.(`auto-run: not returning to ${branch} — the working tree on ${status.branch ?? "a detached HEAD"} has uncommitted changes (${status.entries.map((entry) => entry.path).slice(0, 10).join(", ")})`);
        return;
      }
      await this.options.git.checkout(branch);
      this.options.notifier.notify(autoRunMessage.returned(branch));
    } catch (error) {
      this.options.log?.(`auto-run: could not return to ${branch}: ${message(error)}`);
    }
  }

  /**
   * The run's branch and its target, derived rather than persisted. The record
   * already carries the run id and the branch the user was on, so a stored copy
   * of either could only disagree with them.
   */
  async #resolveSession(record: AutoRunRecord): Promise<RunSession> {
    // The user's own branch is the target. A detached HEAD is the only case with
    // no such branch, and only there does the default branch stand in — a run
    // otherwise never merges into it.
    const base = record.returnBranch ?? await this.#git.defaultBranch();
    return { branch: sessionBranchName(record.runId), base, landed: [] };
  }

  /**
   * Creates and publishes the session branch. Idempotent, because a resumed run
   * finds it already there: existence is checked rather than assumed, and the
   * push is what a pull request base and every `fastForward` afterwards need.
   *
   * A run with its own checkout arrives here with the branch already created and
   * checked out — `git worktree add` does both — so only the push is left.
   */
  async #prepareSessionBranch(session: RunSession): Promise<void> {
    this.options.notifier.notify(autoRunMessage.session(session.branch, session.base));
    await this.#git.fetch();
    const baseOnRemote = await this.#git.remoteBranchExists(session.base);
    if (!await this.#git.branchExists(session.branch)) {
      // Cut from the remote's copy of the base when there is one: a run must not
      // inherit local commits the user has not published, and must not move the
      // user's own branch to do it.
      await this.#git.createBranch(session.branch, baseOnRemote ? `origin/${session.base}` : session.base);
    }
    if (!await this.#git.remoteBranchExists(session.branch)) await this.#git.push(session.branch, true);
    // Said now rather than at the end, while the user can still act on it: a
    // base that is not on origin cannot be a pull request's target.
    if (!baseOnRemote) this.options.notifier.notify(autoRunMessage.baseNotOnRemote(session.base));
  }

  async #run(initial: AutoRunRecord, signal: AbortSignal): Promise<void> {
    // Review mode is decided when a run starts and belongs to that run: a
    // setting changed mid-run must not silently retarget a run already in
    // flight, and a resumed run must behave as the run it is resuming. The rest
    // of the settings are read live because they only affect the next action.
    const settings: AutoRunSettings = { ...this.options.settings(), review: initial.reviewMode };
    const session = await this.#resolveSession(initial);
    // Before anything else: from here on every git effect belongs to the run's
    // own checkout, and a failure to prepare one is a refusal to run at all
    // rather than a silent fall back into the user's tree.
    const workspace = await this.options.workspaces?.prepare({
      runId: initial.runId,
      sessionBranch: session.branch,
      base: session.base,
    });
    this.#workspace = workspace;
    let outcome: RunWorkspaceOutcome = "interrupted";
    try {
      // Inside the try: a session branch that cannot be published still leaves a
      // checkout behind, and the user has to be told where it is.
      await this.#prepareSessionBranch(session);
      outcome = await this.#drive(initial, session, settings, signal);
    } finally {
      // However the run ended — drained, stopped, or aborted — anything already
      // merged onto the session branch is invisible until it has a pull request.
      await this.#concludeRun(session, settings, signal);
      await this.#releaseWorkspace(signal.aborted ? "interrupted" : outcome);
    }
  }

  /**
   * Gives the run's checkout back. Best-effort by contract: the run's outcome
   * stands whatever happens to a directory, and a checkout that survives is
   * reported rather than retried, because the usual reason is a shell of the
   * user's still sitting in it.
   */
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

  async #drive(initial: AutoRunRecord, session: RunSession, settings: AutoRunSettings, signal: AbortSignal): Promise<RunWorkspaceOutcome> {
    let record = initial;
    let completed = 0;
    let parked = 0;
    const reviewed = new Set(record.reviewedIssues);
    const processed = new Set<number>();

    while (!signal.aborted) {
      // Re-derived at every issue boundary, repository-wide: a merge can unblock
      // an older issue that then goes ahead of a newer one, so the plan returned
      // at start is a forecast, not a commitment.
      const selection = selectIssues((await this.options.github.listImplementableIssues()).candidates);
      const remaining = selection.issues.filter((candidate) => !processed.has(candidate.number));
      const issue = remaining[0];
      if (issue === undefined) {
        for (const skipped of selection.skipped) {
          this.options.notifier.notify(`auto-run: issue #${skipped.number} left unprocessed (${skipped.reason}).`);
        }
        this.options.notifier.notify(autoRunMessage.complete(completed, parked));
        await this.options.store.clear();
        // A parked issue is one the user was asked to go and look at, and its
        // terminals and branch are in the run's checkout.
        return parked === 0 ? "drained" : "interrupted";
      }

      // The persisted pull request seeds only the issue it was recorded against.
      // A merged pull request no longer answers a head-branch lookup, so without
      // this a resume could open a second one for work that already landed.
      const knownPullRequest = record.currentIssue === issue.number ? record.prNumber : undefined;
      const outcome = await this.#processIssue(
        issue,
        record,
        session,
        settings,
        completed,
        completed + remaining.length,
        reviewed,
        knownPullRequest,
        signal,
      );
      if (outcome.kind === "stopped") {
        this.options.notifier.alert(autoRunMessage.stopped(issue.number, outcome.reason));
        // The record survives a stop so an explicit resume can re-enter at the
        // failed phase; nothing created before the failure is rolled back.
        await this.options.store.save({ ...record, currentIssue: issue.number, phase: outcome.phase, branch: issue.branch, prNumber: outcome.prNumber });
        return "interrupted";
      }
      if (outcome.kind === "aborted") return "interrupted";
      if (outcome.kind === "parked") {
        // Unlike a stop, this is not evidence that the queue behind it shares a
        // bad premise: a pull request that will not merge is a fact about one
        // branch. The issue is set aside for the user and the run moves on; its
        // dependents stay blocked on their own, because it is still open.
        this.options.notifier.alert(autoRunMessage.parked(issue.number, outcome.prNumber, outcome.reason), outcome.pullRequestUrl);
        // Dropped rather than closed: the user is being asked to resolve this
        // issue's conflict, and its terminals are where they will look first.
        // The set only ever holds the current issue's terminals, because every
        // issue boundary — cleanup or park — empties it.
        this.#openTerminals.clear();
        processed.add(issue.number);
        parked += 1;
        record = { ...record, currentIssue: undefined, phase: "branch", branch: undefined, prNumber: undefined };
        await this.options.store.save(record);
        continue;
      }

      processed.add(issue.number);
      completed += 1;
      if (outcome.landed !== undefined) {
        session.landed.push({ number: issue.number, title: issue.title, prNumber: outcome.landed });
      }
      record = { ...record, currentIssue: undefined, phase: "branch", branch: undefined, prNumber: undefined };
      await this.options.store.save(record);
      if (settings.pauseAfterHitl && issue.disposition === "hitl") {
        this.options.notifier.notify(`auto-run: paused after hitl issue #${issue.number} (aboard.autoRun.pauseAfterHitl). Run /auto to continue.`);
        await this.options.store.clear();
        // Everything this run addressed is committed, pushed, and merged onto
        // the session branch: nothing is left in the checkout to look at, and
        // continuing means a fresh run with a checkout of its own.
        return parked === 0 ? "drained" : "interrupted";
      }
    }
    return "interrupted";
  }

  async #processIssue(
    issue: PlannedIssue,
    record: AutoRunRecord,
    session: RunSession,
    settings: AutoRunSettings,
    completedCount: number,
    totalCount: number,
    reviewed: Set<number>,
    knownPullRequest: number | undefined,
    signal: AbortSignal,
  ): Promise<
    /** `landed` carries the pull request that reached the session branch. */
    | { readonly kind: "done"; readonly landed: number | undefined }
    | { readonly kind: "aborted" }
    | { readonly kind: "stopped"; readonly reason: string; readonly phase: AutoRunPhase; readonly prNumber: number | undefined }
    | { readonly kind: "parked"; readonly reason: string; readonly prNumber: number; readonly pullRequestUrl: string | undefined }
  > {
    // No phase is carried between iterations: the reducer re-derives it from the
    // observed repository every time, so an interrupted run and a fresh one take
    // exactly the same path.
    let phase: AutoRunPhase = "branch";
    let implementationSummary = "";
    let prNumber: number | undefined = knownPullRequest;
    // Insurance for an autonomous loop: every action is meant to change the
    // facts that selected it, so the same action selected repeatedly means a
    // postcondition is not being reached. Stopping beats spinning, and beats
    // relaunching an agent on every pass.
    let previous: string | undefined;
    let repeats = 0;

    for (;;) {
      if (signal.aborted) return { kind: "aborted" };
      const facts = await this.#observe(issue, session.branch, prNumber, reviewed);
      prNumber = facts.pullRequest?.number ?? prNumber;
      const step = nextStep({ issue, baseBranch: session.branch, reviewMode: settings.review, facts });
      phase = step.action === "advance" || step.action === "stop" ? phase : step.action;
      repeats = step.action === previous ? repeats + 1 : 0;
      previous = step.action;
      if (repeats >= 2) {
        return { kind: "stopped", reason: `the ${step.action} phase did not reach its postcondition for issue #${issue.number}`, phase, prNumber };
      }
      this.#publish({
        runId: record.runId,
        phase,
        currentIssue: issue.number,
        completedCount,
        totalCount,
        waiting: step.action === "await-approval",
        chromeEnabled: record.chromeEnabled === true,
        currentPullRequest: prNumber,
      });
      await this.options.store.save({ ...record, currentIssue: issue.number, phase, branch: issue.branch, prNumber, reviewedIssues: [...reviewed] });

      try {
        switch (step.action) {
          case "branch":
            await this.#branch(step.branch, step.base);
            break;
          case "implement": {
            implementationSummary = await this.#implement(issue, record.chromeEnabled === true, record.additionalGuideline, signal);
            // The implement phase's postcondition is "tree dirty on the right
            // branch". It is checked here rather than in the reducer because an
            // unmet one is indistinguishable from "not started yet" in the
            // repository, and relaunching the agent would loop forever.
            const produced = await this.#git.status();
            if (produced.entries.length === 0) {
              return { kind: "stopped", reason: "the implementer produced no changes", phase: "implement", prNumber };
            }
            this.options.notifier.notify(autoRunMessage.implemented(issue.number, issue.branch));
            break;
          }
          case "commit": {
            const sha = await this.#commit(issue, implementationSummary, session.branch);
            // The PR is opened immediately after so the notification can carry
            // both, which is the shape progress reporting specifies. A pull request this run
            // already knows about is reused rather than re-opened: the reducer
            // routes a second dirty tree (a doctor's fixes) back through this
            // same phase, and the branch lookup inside `#openPullRequest` only
            // finds *open* ones, so a merged or closed one would spawn a second.
            const opened = prNumber ?? await this.#openPullRequest(issue, session.branch, implementationSummary);
            prNumber = opened;
            this.#attach(issue.number, opened);
            this.options.notifier.notify(autoRunMessage.committed(issue.number, sha, opened));
            break;
          }
          case "pr": {
            const opened = await this.#openPullRequest(issue, session.branch, implementationSummary);
            prNumber = opened;
            this.#attach(issue.number, opened);
            this.options.notifier.notify(`auto-run: issue #${issue.number} opened PR #${opened}.`);
            break;
          }
          case "review":
            await this.#review(issue, step.prNumber, record.additionalGuideline, signal);
            reviewed.add(issue.number);
            break;
          case "await-approval": {
            const waited = await this.#awaitResolution(issue, step.prNumber, settings, signal);
            if (waited === "aborted") return { kind: "aborted" };
            if (waited === "rejected") {
              return { kind: "stopped", reason: `PR #${step.prNumber} was closed without merging`, phase: "await-approval", prNumber };
            }
            break;
          }
          case "merge": {
            const merged = await this.#merge(issue, step.prNumber, session.branch, settings);
            if (merged !== "merged") return { kind: "parked", ...merged, prNumber: step.prNumber };
            break;
          }
          case "cleanup": {
            // The one place both merge paths meet — the run merged the pull
            // request, or a hitl user did — which is why the issue is closed
            // here rather than beside either merge.
            const landed = facts.pullRequest?.state === "merged" ? facts.pullRequest.number : undefined;
            if (landed !== undefined && !facts.issueClosed) await this.#closeIssue(issue, landed, session);
            await this.#cleanup(session.branch);
            return { kind: "done", landed };
          }
          case "advance":
            return { kind: "done", landed: undefined };
          case "stop":
            return { kind: "stopped", reason: step.reason, phase, prNumber };
        }
      } catch (error) {
        return { kind: "stopped", reason: message(error), phase, prNumber };
      }
    }
  }

  /** Reads the repository, never the record. A record that disagrees loses. */
  async #observe(issue: PlannedIssue, baseBranch: string, knownPullRequest: number | undefined, reviewed: ReadonlySet<number>): Promise<RepositoryFacts> {
    const status = await this.#git.status();
    const branchExists = await this.#git.branchExists(issue.branch);
    const onBranch = status.branch === issue.branch;
    const hasCommit = branchExists && onBranch && await this.#git.hasCommitFor(issue.number, baseBranch);
    // The branch lookup only finds *open* pull requests, so a merged one would
    // read as "no pull request" and the `pr` phase would open a second. Falling
    // back to the number this run already knows keeps the merged state visible.
    const prNumber = (branchExists ? await this.options.github.findOpenPullRequestForBranch(issue.branch) : undefined) ?? knownPullRequest;
    const known = this.#owners.get(prNumber ?? -1);
    let pullRequest: RepositoryFacts["pullRequest"];
    // A number that resolves to nothing is not a pull request. Defaulting an
    // absent snapshot to "open" would let a stale record's number skip the `pr`
    // phase and then try to merge something that was never created.
    const snapshot = prNumber === undefined ? undefined : await this.options.github.getPullRequest(prNumber);
    if (prNumber !== undefined && snapshot !== undefined) {
      const review = await this.options.github.getReviewState(prNumber);
      pullRequest = {
        number: prNumber,
        state: snapshot.state,
        // The extension opens the PR with the user's own credentials and GitHub
        // refuses self-approval, so an `approved` decision can only have come
        // from another account.
        approvedByOther: review.decision === "approved",
      };
    }
    return {
      currentBranch: status.branch,
      branchExists,
      workingTreeDirty: status.entries.length > 0,
      dirtyPaths: status.entries.map((entry) => entry.path),
      hasCommit,
      // Commit and push are two effects that fail independently, so this is a
      // real comparison against the remote tracking ref rather than an alias for
      // `hasCommit`: a push that failed must resume by retrying the push.
      commitPushed: hasCommit && await this.#git.isPushed(issue.branch),
      pullRequest,
      // The in-memory owner is the live signal; the run record carries it across
      // a restart, where the map is empty and a review left no trace in git.
      reviewed: reviewed.has(issue.number) || (known !== undefined && known.type !== "implementer"),
      issueClosed: (await this.options.github.getIssue(issue.number))?.state === "closed",
    };
  }

  async #branch(branch: string, base: string): Promise<void> {
    await this.#git.fetch();
    await this.#git.checkout(base);
    await this.#git.fastForward(base);
    // Issue n+1 therefore branches from a session branch that already contains
    // issue n's merge, which is what makes conflicts a non-event.
    if (await this.#git.branchExists(branch)) await this.#git.checkout(branch);
    else await this.#git.createBranch(branch, base);
  }

  /**
   * The tier every agent sent at this issue runs under. Implementer and doctor
   * share it: the doctor reviews the same change, and a review is not the place
   * to economize below what the work was judged to need.
   */
  #difficulty(issue: PlannedIssue): { readonly difficulty?: IssueDifficulty } {
    return issue.difficulty === undefined ? {} : { difficulty: issue.difficulty };
  }

  async #implement(issue: PlannedIssue, chrome: boolean, additionalGuideline: string | undefined, signal: AbortSignal): Promise<string> {
    const outcome = await this.options.launcher.runAutomated({
      type: "implementer",
      issues: [issue.number],
      description: `address issue ${issue.number}`,
      chrome,
      ...this.#difficulty(issue),
      prompt: `Address issue #${issue.number} on branch \`${issue.branch}\`, which is already checked out. Work only in the directory you started in; it holds the whole repository. Leave your work uncommitted in the working tree: aboard commits, pushes, and opens the pull request for you. Use git and gh only for read-only inspection.`,
      ...guidelineProperty(additionalGuideline),
      expectsUncommittedTree: true,
      ...this.#isolation(),
    }, signal);
    this.#openTerminals.add(outcome.terminalId);
    if (outcome.result.outcome === "failed") {
      throw new Error(`implementer failed: ${outcome.result.failure.type}`);
    }
    this.#remember(issue, outcome, "implementer");
    await this.#comment(issue.number, outcome.result.lastAssistantMessage);
    return outcome.result.lastAssistantMessage;
  }

  /**
   * Posts the implementer's own account of the change on the issue it resolved,
   * where the issue's readers are — the pull request body carries the same text,
   * but a squashed pull request is not where anyone looks a month later.
   *
   * Best-effort by design: the change is already in the working tree, and no
   * phase's postcondition depends on a comment, so a failed comment is logged
   * rather than allowed to fail an issue that was addressed correctly.
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
   * Closes the issue its pull request just merged. Load-bearing rather than
   * cosmetic: GitHub only honours a closing keyword on a merge into the default
   * branch, and nothing here merges there, so without this every issue would
   * stay open — leaving its dependents blocked, the roadmap wrong, and a resumed
   * run free to implement it a second time.
   *
   * A failure is reported and survived. The work is merged either way, and
   * failing the issue after its merge would be a worse answer than an open issue
   * the user can close.
   */
  async #closeIssue(issue: PlannedIssue, prNumber: number, session: RunSession): Promise<void> {
    try {
      await this.options.github.closeIssue(issue.number, issueClosedComment(prNumber, session.branch, session.base));
      this.options.notifier.notify(autoRunMessage.closed(issue.number));
    } catch (error) {
      this.options.notifier.notify(autoRunMessage.notClosed(issue.number, message(error)));
    }
  }

  async #commit(issue: PlannedIssue, summary: string, base: string): Promise<string> {
    // The implementer is told not to touch git, but it has Bash. A mismatch
    // stops the run rather than committing to the wrong place.
    const current = await this.#git.currentBranch();
    if (current !== issue.branch) {
      throw new Error(`the repository is on ${current ?? "a detached HEAD"} but issue #${issue.number} belongs on ${issue.branch}`);
    }
    const status = await this.#git.status();
    if (status.entries.length > 0) {
      await this.#git.add();
      await this.#git.commit(
        commitSubject(issue.title),
        `Addresses #${issue.number}.\n\n${summary.trim().slice(0, 500)}`.trim(),
      );
    } else if (!await this.#git.hasCommitFor(issue.number, base)) {
      throw new Error("the implementer produced no changes");
    }
    // Reached with a clean tree when a previous attempt committed and then failed
    // to push. Pushing is the whole remaining postcondition, and `-u` is
    // idempotent on a branch that already tracks.
    await this.#git.push(issue.branch, true);
    return this.#git.headSha();
  }

  async #openPullRequest(issue: PlannedIssue, base: string, summary: string): Promise<number> {
    const existing = await this.options.github.findOpenPullRequestForBranch(issue.branch);
    if (existing !== undefined) return existing;
    return this.options.github.createPullRequest({
      title: issue.title,
      body: pullRequestBody(summary, issue.number),
      head: issue.branch,
      base,
    });
  }

  async #review(issue: PlannedIssue, prNumber: number, additionalGuideline: string | undefined, signal: AbortSignal): Promise<void> {
    if (issue.disposition === "hitl") {
      // Interactive: the terminal is focused and handed over, and no result is
      // delivered. The run's continue signal is the PR's resolution.
      // Leased despite being handed to the user: the run is still in flight
      // behind this terminal and the extension commits, pushes, and merges its
      // branch, so a second writer here is the collision the lease exists for.
      const handles = await this.options.launcher.launchInteractive({
        type: "pr-doctor-hitl",
        issues: [issue.number],
        pullRequest: prNumber,
        description: `review pull request ${prNumber}`,
        ...guidelineProperty(additionalGuideline),
        ...this.#difficulty(issue),
        // The doctor's fixes are committed by the run, from the same checkout
        // the implementer worked in — so it has to be in that checkout.
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
      ...guidelineProperty(additionalGuideline),
      expectsUncommittedTree: true,
      ...this.#difficulty(issue),
      ...this.#isolation(),
    }, signal);
    this.#openTerminals.add(outcome.terminalId);
    if (outcome.result.outcome === "failed") throw new Error(`pr-doctor-afk failed: ${outcome.result.failure.type}`);
    this.#remember(issue, outcome, "pr-doctor-afk");

    // The user may have been typing into the still-open implementation terminal
    // while the doctor worked, so re-read the tree rather than assuming it holds
    // only the doctor's changes, and say what is being committed.
    const status = await this.#git.status();
    this.options.notifier.notify(autoRunMessage.reviewed(issue.number, status.entries.map((entry) => entry.path)));
    if (status.entries.length === 0) return;
    await this.#git.add();
    await this.#git.commit(
      `Address review findings on #${issue.number}`,
      outcome.result.lastAssistantMessage.trim().slice(0, 500),
    );
    await this.#git.push(issue.branch, false);
  }

  async #awaitResolution(
    issue: PlannedIssue,
    prNumber: number,
    settings: AutoRunSettings,
    signal: AbortSignal,
  ): Promise<"merged" | "rejected" | "aborted"> {
    this.options.notifier.notify(autoRunMessage.waiting(issue.number, prNumber));
    while (!signal.aborted) {
      // Before reading the pull request, push anything the open terminals have
      // produced. A hitl pr-doctor applies the fixes the user approved but never
      // commits them, and the implementation terminal is still open too; without
      // this the user merges a pull request that does not contain the changes
      // they just approved, and the work is stranded uncommitted.
      await this.#captureOpenWork(issue, prNumber);
      const snapshot = await this.options.github.getPullRequest(prNumber);
      if (snapshot?.state === "merged") {
        this.options.notifier.notify(autoRunMessage.resolved(prNumber));
        return "merged";
      }
      if (snapshot?.state === "closed") return "rejected";
      // Approval is the secondary signal, for a repository with a second
      // identity; there the engine performs the merge itself.
      if ((await this.options.github.getReviewState(prNumber)).decision === "approved") return "merged";
      await this.#waitForPoll(settings.pollSeconds, signal);
    }
    return "aborted";
  }

  /**
   * Commits and pushes whatever is in the working tree while a hitl pull request
   * waits. Deliberately not conditioned on review mode: the user may equally
   * have edited in the implementation terminal, and committing to the branch
   * they are about to merge is what they expect. It is always announced, because
   * a commit nobody asked for must not be a silent one.
   */
  async #captureOpenWork(issue: PlannedIssue, prNumber: number): Promise<void> {
    const status = await this.#git.status();
    if (status.entries.length === 0) return;
    if (status.branch !== issue.branch) {
      // Committing from the wrong branch would put the work somewhere nobody is
      // reviewing. Say so and leave it; the branch check in `#commit` and the
      // reducer's `branch` guard both refuse for the same reason.
      this.options.log?.(`auto-run left uncommitted work on ${status.branch ?? "a detached HEAD"}: issue #${issue.number} belongs on ${issue.branch}`);
      return;
    }
    const paths = status.entries.map((entry) => entry.path);
    await this.#git.add();
    await this.#git.commit(
      `Address review findings on #${issue.number}`,
      `Applied while PR #${prNumber} was open for review.`,
    );
    await this.#git.push(issue.branch, false);
    this.options.notifier.notify(autoRunMessage.captured(issue.number, prNumber, paths));
  }

  /**
   * Merges the pull request, or reports why the user has to. A conflict is the
   * one failure worth attempting to repair here, because the run creates it: a
   * branch is cut from a fresh base, so the only way it falls behind is a push
   * to the base while this issue was in flight — routinely the user's own merge
   * during a hitl wait.
   */
  async #merge(
    issue: PlannedIssue,
    prNumber: number,
    base: string,
    settings: AutoRunSettings,
  ): Promise<"merged" | { readonly reason: string; readonly pullRequestUrl: string | undefined }> {
    const snapshot = await this.options.github.getPullRequest(prNumber);
    if (snapshot?.state !== "merged") {
      // A known conflict is repaired before the merge is attempted; an `unknown`
      // verdict — the normal answer for a head pushed seconds ago — is left to
      // the attempt itself rather than waited on.
      if (snapshot?.mergeable === "conflicting") {
        if (!await this.#reconcile(issue.branch, base)) {
          return { reason: `it conflicts with ${base} and the conflict is not one aboard can resolve`, pullRequestUrl: snapshot.url };
        }
        this.options.notifier.notify(autoRunMessage.reconciled(issue.number, prNumber, base));
      }
      try {
        // The issue branch is deleted with its merge: nothing targets it, and
        // the work is on the session branch from here on.
        await this.options.github.mergePullRequest(prNumber, settings.mergeStrategy, true);
      } catch (error) {
        // Re-read rather than guess: by now GitHub has computed a verdict the
        // pre-merge read may not have had, and a conflict and a protected
        // branch need opposite things from the user.
        const after = await this.options.github.getPullRequest(prNumber);
        if (after?.state === "merged") {
          this.options.log?.(`auto-run: PR #${prNumber} was already merged when the merge failed (${message(error)})`);
        } else if (after?.mergeable === "conflicting") {
          return { reason: `it conflicts with ${base}`, pullRequestUrl: after.url };
        } else {
          // Not a fact about this branch. Branch protection that requires a
          // review applies to every pull request the run will open, so unlike a
          // conflict this stops the run rather than parking one issue.
          throw new Error(
            `merging PR #${prNumber} failed (${message(error)}). If the branch requires a review, auto-run cannot approve its own pull request — merge it yourself and re-run /auto.`,
          );
        }
      }
    }
    this.options.notifier.notify(autoRunMessage.merged(issue.number, base));
    this.#owners.delete(prNumber);
    return "merged";
  }

  /**
   * Brings a branch up to date with its base and pushes the result. Refuses on
   * anything it did not put there: merging over uncommitted work, or from the
   * wrong branch, would strand changes nobody is reviewing in a tree the user
   * did not ask to have merged.
   */
  async #reconcile(branch: string, base: string): Promise<boolean> {
    const status = await this.#git.status();
    if (status.branch !== branch || status.entries.length > 0) return false;
    await this.#git.fetch();
    if (!await this.#git.mergeFromRemote(base)) return false;
    await this.#git.push(branch, false);
    return true;
  }

  async #cleanup(sessionBranch: string): Promise<void> {
    for (const terminalId of this.#openTerminals) {
      try { this.options.terminals.close(terminalId); } catch { /* already closed */ }
    }
    this.#openTerminals.clear();
    try {
      // Back to the session branch, never the default one: the run's work lives
      // there, and the next issue's `branch` phase starts from it anyway.
      await this.#git.checkout(sessionBranch);
    } catch (error) {
      // Cleanup failure is logged and the run continues: the work is merged and
      // the next issue's `branch` phase checks the branch out anyway.
      this.options.log?.(`auto-run cleanup could not return to ${sessionBranch}: ${message(error)}`);
    }
  }

  /**
   * Opens — and, when the user has allowed it, merges — the run's own pull
   * request. This is the only place a run touches a branch the user owns, and it
   * is the reason the per-issue merges can be automatic: they land on a branch
   * nobody else is working on.
   *
   * Runs on every exit, including a stop or an abort, because work already
   * merged onto the session branch is invisible until it has a pull request. It
   * never throws: the run is over, and its outcome stands whatever happens here.
   */
  async #concludeRun(session: RunSession, settings: AutoRunSettings, signal: AbortSignal): Promise<void> {
    if (session.landed.length === 0) return;
    try {
      if (!await this.#git.remoteBranchExists(session.base)) {
        this.options.notifier.alert(autoRunMessage.runNotOpened(session.branch, session.base, `${session.base} is not on origin`));
        return;
      }
      const existing = await this.options.github.findOpenPullRequestForBranch(session.branch);
      const prNumber = existing ?? await this.options.github.createPullRequest({
        title: runPullRequestTitle(session.landed),
        body: runPullRequestBody(session.landed, session.branch, session.base),
        head: session.branch,
        base: session.base,
      });
      this.options.notifier.notify(autoRunMessage.runOpened(prNumber, session.base, session.landed.length));
      const snapshot = await this.options.github.getPullRequest(prNumber);
      // An aborted run is one the user interrupted; finishing it with a merge
      // into their branch would be the opposite of what they asked for.
      if (!settings.mergeRunPullRequest || signal.aborted) {
        this.options.notifier.alert(autoRunMessage.runWaiting(prNumber, session.base), snapshot?.url);
        return;
      }
      await this.#mergeRun(session, prNumber, settings);
    } catch (error) {
      this.options.notifier.alert(autoRunMessage.runNotOpened(session.branch, session.base, message(error)));
    }
  }

  /**
   * The run's own merge. Unlike an issue's, this one competes with whatever the
   * user (or anyone else) pushed to their branch while the run worked, so a
   * conflict here is ordinary rather than exceptional — and a conflict aboard
   * cannot resolve is handed back with the pull request intact rather than
   * retried.
   */
  async #mergeRun(session: RunSession, prNumber: number, settings: AutoRunSettings): Promise<void> {
    const snapshot = await this.options.github.getPullRequest(prNumber);
    if (snapshot?.state === "merged") {
      this.options.notifier.notify(autoRunMessage.runMerged(prNumber, session.base));
      return;
    }
    if (snapshot?.mergeable === "conflicting" && !await this.#syncSessionBranch(session)) {
      this.options.notifier.alert(autoRunMessage.runParked(prNumber, session.base, `it conflicts with ${session.base}`), snapshot.url);
      return;
    }
    try {
      // The session branch survives its merge: parked and unmerged issue pull
      // requests still target it, and deleting a base branch closes them.
      await this.options.github.mergePullRequest(prNumber, settings.mergeStrategy, false);
      this.options.notifier.notify(autoRunMessage.runMerged(prNumber, session.base));
    } catch (error) {
      const after = await this.options.github.getPullRequest(prNumber);
      if (after?.state === "merged") this.options.notifier.notify(autoRunMessage.runMerged(prNumber, session.base));
      else this.options.notifier.alert(autoRunMessage.runParked(prNumber, session.base, message(error)), after?.url ?? snapshot?.url);
    }
  }

  /**
   * Catches the local session branch up with its merged issues, then merges the
   * base into it. The catch-up is what an issue branch never needs: every issue
   * merge happened on GitHub, so the local branch is behind its own remote and a
   * push after reconciling would be rejected.
   */
  async #syncSessionBranch(session: RunSession): Promise<boolean> {
    try {
      const status = await this.#git.status();
      if (status.entries.length > 0) return false;
      if (status.branch !== session.branch) await this.#git.checkout(session.branch);
      await this.#git.fetch();
      await this.#git.fastForward(session.branch);
      return await this.#reconcile(session.branch, session.base);
    } catch (error) {
      this.options.log?.(`auto-run could not reconcile ${session.branch} with ${session.base}: ${message(error)}`);
      return false;
    }
  }

  /** The run preconditions, in order; the first failure refuses the run. */
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
    // A run that works in its own checkout never reads, stages, or moves this
    // tree, so what is in it is the user's business — leaving them free to keep
    // working while the run does. The requirement below is about the tree the
    // run stages from, and in that mode it is not this one.
    if (status.entries.length > 0 && this.options.workspaces?.isolates() !== true) {
      // Binding: the engine stages with `git add -A`, so a dirty tree would
      // sweep unrelated work into an automated commit. Name the paths rather
      // than guessing which changes belong to whom.
      const paths = status.entries.map((entry) => entry.path);
      return `the working tree is not clean: ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? `, and ${paths.length - 20} more` : ""}`;
    }
    return undefined;
  }

  /** Recovery needs the infrastructure checks, but its tree may be intentionally dirty. */
  async #checkResumePreconditions(): Promise<string | undefined> {
    try {
      await this.options.git.defaultBranch();
    } catch (error) {
      return `the workspace is not a usable git repository (${message(error)})`;
    }
    return this.#checkGitHubAuthentication();
  }

  async #checkGitHubAuthentication(): Promise<string | undefined> {
    try {
      await this.options.github.checkAuthentication();
      return undefined;
    } catch (error) {
      return `GitHub CLI cannot authenticate to this repository; run gh auth status and gh auth login if needed (${message(error)})`;
    }
  }

  /**
   * Records the agent that last worked an issue. The pull request may not exist
   * yet when the implementer finishes, so ownership is keyed by issue first and
   * bound to the pull request by `#attach` once it is open. `review_pr` reads
   * the result: the implementer owns the PR when review is off, the pr-doctor
   * when it is on.
   */
  #remember(issue: PlannedIssue, outcome: AutomatedLaunchOutcome, type: PullRequestOwner["type"]): void {
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
  }
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

/** Normalizes the optional run-wide user text once at its boundary. */
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
