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
  nextStep,
  pullRequestBody,
  selectIssues,
  type AutoRunPhase,
  type AutoRunRecord,
  type AutoRunSettings,
  type PlannedIssue,
  type RepositoryFacts,
  type SkippedIssue,
} from "../domain/auto-run.js";
import type { AgentId, SessionId, TerminalId } from "../domain/contracts.js";
import type { LaunchOrigin } from "../domain/lease.js";
import type { GitClient } from "../git/client.js";
import type { AutomatedLaunchOutcome, DelegationLaunchInput, InteractiveLaunchHandles } from "../bridge/delegation.js";

/** The GitHub surface the engine needs, narrowed so tests can fake it whole. */
export interface AutoRunGitHub {
  /** Proves that gh can authenticate to and resolve the workspace repository. */
  checkAuthentication(): Promise<void>;
  listSpecIssues(): Promise<readonly { readonly number: number; readonly title: string; readonly createdAt: string }[]>;
  listSubIssues(parentNumber: number): Promise<readonly {
    readonly number: number;
    readonly title: string;
    readonly labels: readonly string[];
    readonly state: "open" | "closed";
    readonly openBlockedByNumbers: readonly number[];
  }[]>;
  getIssue(number: number): Promise<{ readonly state: "open" | "closed" } | undefined>;
  createPullRequest(input: { readonly title: string; readonly body: string; readonly head: string; readonly base: string }): Promise<number>;
  findOpenPullRequestForBranch(branch: string): Promise<number | undefined>;
  getPullRequest(number: number): Promise<{ readonly state: "open" | "closed" | "merged" } | undefined>;
  getReviewState(number: number): Promise<{ readonly decision: "approved" | "changes-requested" | "reviewed" | "unreviewed" }>;
  mergePullRequest(number: number, strategy: "squash" | "merge" | "rebase"): Promise<void>;
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
}

/** Who owns an open pull request, so `review_pr` can reopen that session. */
export interface PullRequestOwner {
  readonly prNumber: number;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: TerminalId;
  readonly type: "implementer" | "pr-doctor-afk" | "pr-doctor-hitl";
  readonly issueNumber: number;
}

export interface AutoRunEngineOptions {
  readonly git: GitClient;
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
  readonly specNumber: number;
  readonly specTitle: string;
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
      readonly spec: { readonly number: number; readonly title: string };
      readonly reviewMode: boolean;
      readonly chromeEnabled: boolean;
      readonly scope: AutoRunSettings["scope"];
      readonly issues: readonly PlannedIssue[];
      readonly skipped: readonly SkippedIssue[];
    }
  | { readonly started: false; readonly reason: string; readonly active?: AutoRunState };

export class AutoRunEngine {
  #controller: AbortController | undefined;
  #state: AutoRunState | undefined;
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

  /** The owning agent for an open pull request, or `undefined` if unknown. */
  public owner(prNumber: number): PullRequestOwner | undefined {
    return this.#owners.get(prNumber);
  }

  /**
   * Starts a run. Returns as soon as the plan is resolved: a multi-issue run
   * routinely outlasts any single command, and the run must outlive the
   * Manager that triggered it.
   */
  public async start(options: { readonly chrome?: boolean } = {}): Promise<AutoRunStartResult> {
    if (this.#state !== undefined) {
      return { started: false, reason: "a run is already active", active: this.#state };
    }
    const settings = this.options.settings();
    const precondition = await this.#checkPreconditions();
    if (precondition !== undefined) return { started: false, reason: precondition };

    const specs = await this.options.github.listSpecIssues();
    const spec = specs[0];
    if (spec === undefined) return { started: false, reason: "no open issue is labelled ai:spec" };
    const selection = selectIssues(await this.options.github.listSubIssues(spec.number));
    if (selection.issues.length === 0) {
      return {
        started: false,
        reason: `spec #${spec.number} has no processable child (open, afk or hitl, not blocked)`,
      };
    }
    // Where the user was when the run took over. Read here — after the
    // clean-tree precondition, before the first branch phase moves HEAD — so the
    // end-of-run restore targets the branch the run actually displaced. A
    // detached HEAD records `undefined` and the restore is skipped.
    const returnBranch = await this.options.git.currentBranch();

    const record: AutoRunRecord = {
      version: 1,
      runId: this.#runId(),
      specNumber: spec.number,
      issueNumbers: selection.issues.map((issue) => issue.number),
      currentIssue: selection.issues[0]?.number,
      phase: "branch",
      branch: selection.issues[0]?.branch,
      prNumber: undefined,
      reviewMode: settings.review,
      chromeEnabled: options.chrome === true,
      scope: settings.scope,
      returnBranch,
      reviewedIssues: [],
      startedAt: this.#now().toISOString(),
    };
    await this.options.store.save(record);
    const afk = selection.issues.filter((issue) => issue.disposition === "afk").length;
    this.options.notifier.notify(autoRunMessage.started(spec.number, spec.title, afk, selection.issues.length - afk, settings.review, record.chromeEnabled === true));
    for (const skipped of selection.skipped) {
      this.options.notifier.notify(`auto-run: issue #${skipped.number} skipped (${skipped.reason}).`);
    }

    this.#begin(record, spec.title);
    return {
      started: true,
      runId: record.runId,
      spec: { number: spec.number, title: spec.title },
      reviewMode: settings.review,
      chromeEnabled: record.chromeEnabled === true,
      scope: settings.scope,
      issues: selection.issues,
      skipped: selection.skipped,
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
    const specs = await this.options.github.listSpecIssues();
    const spec = specs.find((candidate) => candidate.number === record.specNumber);
    const selection = selectIssues(await this.options.github.listSubIssues(record.specNumber));
    this.#begin(record, spec?.title ?? `#${record.specNumber}`);
    return {
      started: true,
      runId: record.runId,
      spec: { number: record.specNumber, title: spec?.title ?? `#${record.specNumber}` },
      reviewMode: record.reviewMode,
      chromeEnabled: record.chromeEnabled === true,
      scope: record.scope,
      issues: selection.issues,
      skipped: selection.skipped,
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

  #begin(record: AutoRunRecord, specTitle: string): void {
    const controller = new AbortController();
    this.#controller = controller;
    // All exits below carry the branch the user was on when the run started, so
    // however the run ends it leaves the checkout where it found it.
    const homeBranch = record.returnBranch;
    this.#publish({
      runId: record.runId,
      specNumber: record.specNumber,
      specTitle,
      phase: record.phase,
      currentIssue: record.currentIssue,
      completedCount: 0,
      totalCount: record.issueNumbers.length,
      waiting: false,
      chromeEnabled: record.chromeEnabled === true,
      currentPullRequest: record.prNumber,
    });
    this.#loop = this.#run(record, specTitle, controller.signal).catch((error: unknown) => {
      this.options.log?.(`auto-run failed: ${message(error)}`);
      this.options.notifier.notify(autoRunMessage.stopped(this.#state?.currentIssue, message(error)));
    }).finally(() => {
      this.#controller = undefined;
      void this.#restoreOriginalBranch(homeBranch).finally(() => {
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
   */
  async #restoreOriginalBranch(branch: string | undefined): Promise<void> {
    if (branch === undefined) return;
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

  async #run(initial: AutoRunRecord, initialTitle: string, signal: AbortSignal): Promise<void> {
    let record = initial;
    let specTitle = initialTitle;
    let completed = 0;
    // Review mode and scope are decided when a run starts and belong to that
    // run: a setting changed mid-run must not silently retarget a run already in
    // flight, and a resumed run must behave as the run it is resuming. The rest
    // of the settings are read live because they only affect the next action.
    const settings: AutoRunSettings = { ...this.options.settings(), review: record.reviewMode, scope: record.scope };
    const reviewed = new Set(record.reviewedIssues);
    const defaultBranch = await this.options.git.defaultBranch();
    const processed = new Set<number>();
    const finishedSpecs = new Set<number>();

    while (!signal.aborted) {
      // Re-derived at every issue boundary: a merge can unblock a later sibling,
      // so the plan returned at start is a forecast, not a commitment.
      const selection = selectIssues(await this.options.github.listSubIssues(record.specNumber));
      const issue = selection.issues.find((candidate) => !processed.has(candidate.number));
      if (issue === undefined) {
        for (const skipped of selection.skipped) {
          this.options.notifier.notify(`auto-run: issue #${skipped.number} left unprocessed (${skipped.reason}).`);
        }
        finishedSpecs.add(record.specNumber);
        const remaining = (await this.options.github.listSpecIssues()).filter((spec) => !finishedSpecs.has(spec.number));
        this.options.notifier.notify(autoRunMessage.complete(record.specNumber, completed, remaining.length));
        // A spec is the natural human review unit, and the run's irreversible
        // acts should have a bounded blast radius per invocation. `all`
        // is the opt-in that trades that bound for fewer gestures.
        const next = settings.scope === "all" ? remaining[0] : undefined;
        if (next === undefined) {
          await this.options.store.clear();
          return;
        }
        specTitle = next.title;
        completed = 0;
        processed.clear();
        record = { ...record, specNumber: next.number, currentIssue: undefined, phase: "branch", branch: undefined, prNumber: undefined };
        await this.options.store.save(record);
        this.options.notifier.notify(`auto-run: continuing into spec #${next.number} "${next.title}" (aboard.autoRun.scope is all).`);
        continue;
      }

      // The persisted pull request seeds only the issue it was recorded against.
      // A merged pull request no longer answers a head-branch lookup, so without
      // this a resume could open a second one for work that already landed.
      const knownPullRequest = record.currentIssue === issue.number ? record.prNumber : undefined;
      const outcome = await this.#processIssue(issue, record, defaultBranch, settings, specTitle, completed, reviewed, knownPullRequest, signal);
      if (outcome.kind === "stopped") {
        this.options.notifier.notify(autoRunMessage.stopped(issue.number, outcome.reason));
        // The record survives a stop so an explicit resume can re-enter at the
        // failed phase; nothing created before the failure is rolled back.
        await this.options.store.save({ ...record, currentIssue: issue.number, phase: outcome.phase, branch: issue.branch, prNumber: outcome.prNumber });
        return;
      }
      if (outcome.kind === "aborted") return;

      processed.add(issue.number);
      completed += 1;
      record = { ...record, currentIssue: undefined, phase: "branch", branch: undefined, prNumber: undefined };
      await this.options.store.save(record);
      if (settings.pauseAfterHitl && issue.disposition === "hitl") {
        this.options.notifier.notify(`auto-run: paused after hitl issue #${issue.number} (aboard.autoRun.pauseAfterHitl). Run /auto to continue.`);
        await this.options.store.clear();
        return;
      }
    }
  }

  async #processIssue(
    issue: PlannedIssue,
    record: AutoRunRecord,
    defaultBranch: string,
    settings: AutoRunSettings,
    specTitle: string,
    completedCount: number,
    reviewed: Set<number>,
    knownPullRequest: number | undefined,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "done" }
    | { readonly kind: "aborted" }
    | { readonly kind: "stopped"; readonly reason: string; readonly phase: AutoRunPhase; readonly prNumber: number | undefined }
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
      const facts = await this.#observe(issue, defaultBranch, prNumber, reviewed);
      prNumber = facts.pullRequest?.number ?? prNumber;
      const step = nextStep({ issue, defaultBranch, reviewMode: settings.review, facts });
      phase = step.action === "advance" || step.action === "stop" ? phase : step.action;
      repeats = step.action === previous ? repeats + 1 : 0;
      previous = step.action;
      if (repeats >= 2) {
        return { kind: "stopped", reason: `the ${step.action} phase did not reach its postcondition for issue #${issue.number}`, phase, prNumber };
      }
      this.#publish({
        runId: record.runId,
        specNumber: record.specNumber,
        specTitle,
        phase,
        currentIssue: issue.number,
        completedCount,
        totalCount: Math.max(record.issueNumbers.length, completedCount + 1),
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
            implementationSummary = await this.#implement(issue, record.chromeEnabled === true, signal);
            // The implement phase's postcondition is "tree dirty on the right
            // branch". It is checked here rather than in the reducer because an
            // unmet one is indistinguishable from "not started yet" in the
            // repository, and relaunching the agent would loop forever.
            const produced = await this.options.git.status();
            if (produced.entries.length === 0) {
              return { kind: "stopped", reason: "the implementer produced no changes", phase: "implement", prNumber };
            }
            this.options.notifier.notify(autoRunMessage.implemented(issue.number, issue.branch));
            break;
          }
          case "commit": {
            const sha = await this.#commit(issue, implementationSummary);
            // The PR is opened immediately after so the notification can carry
            // both, which is the shape progress reporting specifies. A pull request this run
            // already knows about is reused rather than re-opened: the reducer
            // routes a second dirty tree (a doctor's fixes) back through this
            // same phase, and the branch lookup inside `#openPullRequest` only
            // finds *open* ones, so a merged or closed one would spawn a second.
            const opened = prNumber ?? await this.#openPullRequest(issue, defaultBranch, implementationSummary);
            prNumber = opened;
            this.#attach(issue.number, opened);
            this.options.notifier.notify(autoRunMessage.committed(issue.number, sha, opened));
            break;
          }
          case "pr": {
            const opened = await this.#openPullRequest(issue, defaultBranch, implementationSummary);
            prNumber = opened;
            this.#attach(issue.number, opened);
            this.options.notifier.notify(`auto-run: issue #${issue.number} opened PR #${opened}.`);
            break;
          }
          case "review":
            await this.#review(issue, step.prNumber, signal);
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
          case "merge":
            await this.#merge(issue, step.prNumber, settings);
            break;
          case "cleanup":
            await this.#cleanup(defaultBranch);
            return { kind: "done" };
          case "advance":
            return { kind: "done" };
          case "stop":
            return { kind: "stopped", reason: step.reason, phase, prNumber };
        }
      } catch (error) {
        return { kind: "stopped", reason: message(error), phase, prNumber };
      }
    }
  }

  /** Reads the repository, never the record. A record that disagrees loses. */
  async #observe(issue: PlannedIssue, defaultBranch: string, knownPullRequest: number | undefined, reviewed: ReadonlySet<number>): Promise<RepositoryFacts> {
    const status = await this.options.git.status();
    const branchExists = await this.options.git.branchExists(issue.branch);
    const onBranch = status.branch === issue.branch;
    const hasCommit = branchExists && onBranch && await this.options.git.hasCommitFor(issue.number, defaultBranch);
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
      commitPushed: hasCommit && await this.options.git.isPushed(issue.branch),
      pullRequest,
      // The in-memory owner is the live signal; the run record carries it across
      // a restart, where the map is empty and a review left no trace in git.
      reviewed: reviewed.has(issue.number) || (known !== undefined && known.type !== "implementer"),
      issueClosed: (await this.options.github.getIssue(issue.number))?.state === "closed",
    };
  }

  async #branch(branch: string, base: string): Promise<void> {
    await this.options.git.fetch();
    await this.options.git.checkout(base);
    await this.options.git.fastForward(base);
    // Issue n+1 therefore branches from a default branch that already contains
    // issue n's merge, which is what makes conflicts a non-event.
    if (await this.options.git.branchExists(branch)) await this.options.git.checkout(branch);
    else await this.options.git.createBranch(branch, base);
  }

  async #implement(issue: PlannedIssue, chrome: boolean, signal: AbortSignal): Promise<string> {
    const outcome = await this.options.launcher.runAutomated({
      type: "implementer",
      issues: [issue.number],
      description: `implement issue ${issue.number}`,
      chrome,
      prompt: `Implement issue #${issue.number} on branch \`${issue.branch}\`, which is already checked out. Leave your work uncommitted in the working tree: aboard commits, pushes, and opens the pull request for you. Do not run git commit, git push, or gh.`,
      expectsUncommittedTree: true,
    }, signal);
    this.#openTerminals.add(outcome.terminalId);
    if (outcome.result.outcome === "failed") {
      throw new Error(`implementer failed: ${outcome.result.failure.type}`);
    }
    this.#remember(issue, outcome, "implementer");
    return outcome.result.lastAssistantMessage;
  }

  async #commit(issue: PlannedIssue, summary: string): Promise<string> {
    // The implementer is told not to touch git, but it has Bash. A mismatch
    // stops the run rather than committing to the wrong place.
    const current = await this.options.git.currentBranch();
    if (current !== issue.branch) {
      throw new Error(`the repository is on ${current ?? "a detached HEAD"} but issue #${issue.number} belongs on ${issue.branch}`);
    }
    const status = await this.options.git.status();
    if (status.entries.length > 0) {
      await this.options.git.add();
      await this.options.git.commit(
        commitSubject(issue.title),
        `Implements #${issue.number}.\n\n${summary.trim().slice(0, 500)}`.trim(),
      );
    } else if (!await this.options.git.hasCommitFor(issue.number, await this.options.git.defaultBranch())) {
      throw new Error("the implementer produced no changes");
    }
    // Reached with a clean tree when a previous attempt committed and then failed
    // to push. Pushing is the whole remaining postcondition, and `-u` is
    // idempotent on a branch that already tracks.
    await this.options.git.push(issue.branch, true);
    return this.options.git.headSha();
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

  async #review(issue: PlannedIssue, prNumber: number, signal: AbortSignal): Promise<void> {
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
      }, "auto-run");
      this.#openTerminals.add(handles.terminalId);
      this.#owners.set(prNumber, { prNumber, ...handles, type: "pr-doctor-hitl", issueNumber: issue.number });
      return;
    }
    const outcome = await this.options.launcher.runAutomated({
      type: "pr-doctor-afk",
      issues: [issue.number],
      pullRequest: prNumber,
      description: `review pull request ${prNumber}`,
      expectsUncommittedTree: true,
    }, signal);
    this.#openTerminals.add(outcome.terminalId);
    if (outcome.result.outcome === "failed") throw new Error(`pr-doctor-afk failed: ${outcome.result.failure.type}`);
    this.#remember(issue, outcome, "pr-doctor-afk");

    // The user may have been typing into the still-open implementation terminal
    // while the doctor worked, so re-read the tree rather than assuming it holds
    // only the doctor's changes, and say what is being committed.
    const status = await this.options.git.status();
    this.options.notifier.notify(autoRunMessage.reviewed(issue.number, status.entries.map((entry) => entry.path)));
    if (status.entries.length === 0) return;
    await this.options.git.add();
    await this.options.git.commit(
      `Address review findings on #${issue.number}`,
      outcome.result.lastAssistantMessage.trim().slice(0, 500),
    );
    await this.options.git.push(issue.branch, false);
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
    const status = await this.options.git.status();
    if (status.entries.length === 0) return;
    if (status.branch !== issue.branch) {
      // Committing from the wrong branch would put the work somewhere nobody is
      // reviewing. Say so and leave it; the branch check in `#commit` and the
      // reducer's `branch` guard both refuse for the same reason.
      this.options.log?.(`auto-run left uncommitted work on ${status.branch ?? "a detached HEAD"}: issue #${issue.number} belongs on ${issue.branch}`);
      return;
    }
    const paths = status.entries.map((entry) => entry.path);
    await this.options.git.add();
    await this.options.git.commit(
      `Address review findings on #${issue.number}`,
      `Applied while PR #${prNumber} was open for review.`,
    );
    await this.options.git.push(issue.branch, false);
    this.options.notifier.notify(autoRunMessage.captured(issue.number, prNumber, paths));
  }

  async #merge(issue: PlannedIssue, prNumber: number, settings: AutoRunSettings): Promise<void> {
    const snapshot = await this.options.github.getPullRequest(prNumber);
    if (snapshot?.state !== "merged") {
      try {
        await this.options.github.mergePullRequest(prNumber, settings.mergeStrategy);
      } catch (error) {
        // Branch protection that requires a review cannot be satisfied without a
        // second identity, and saying so beats appearing stuck.
        throw new Error(
          `merging PR #${prNumber} failed (${message(error)}). If the branch requires a review, auto-run cannot approve its own pull request — merge it yourself and re-run /auto.`,
        );
      }
    }
    this.options.notifier.notify(autoRunMessage.merged(issue.number));
    this.#owners.delete(prNumber);
  }

  async #cleanup(defaultBranch: string): Promise<void> {
    for (const terminalId of this.#openTerminals) {
      try { this.options.terminals.close(terminalId); } catch { /* already closed */ }
    }
    this.#openTerminals.clear();
    try {
      await this.options.git.checkout(defaultBranch);
    } catch (error) {
      // Cleanup failure is logged and the run continues: the work is merged and
      // the next issue's `branch` phase checks out the default branch anyway.
      this.options.log?.(`auto-run cleanup could not return to ${defaultBranch}: ${message(error)}`);
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
    if (status.entries.length > 0) {
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
