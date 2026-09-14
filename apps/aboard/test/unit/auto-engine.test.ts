import assert from "node:assert/strict";
import test from "node:test";

import { AutoRunEngine, continuationSessionFor, type AutoRunGitHub, type AutoRunLauncher, type AutoRunState } from "../../src/auto/engine.js";
import type { AutoRunSettings } from "../../src/domain/auto-run.js";
import type { AutoRunRecord } from "../../src/domain/run-plan.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import type { LaunchOrigin } from "../../src/domain/lease.js";
import { GitBoundaryError, type GitClient, type GitStatus } from "../../src/git/client.js";
import { GitHubBoundaryError } from "../../src/github/client.js";
import type { RunWorkspaceOutcome, RunWorkspaceProvider } from "../../src/auto/worktree.js";
import { observeRun } from "../../src/auto/observation.js";
import { parseAutoRunRecord } from "../../src/runtime/persistence.js";
import type { DelegationLaunchInput } from "../../src/bridge/delegation.js";

const WORKTREE_OFF = { enabled: false, root: "", keep: false, setupTimeoutSeconds: 600 } as const;
const SETTINGS: AutoRunSettings = { review: false, exploreBeforeImplement: false, issueContextDepth: 1, permanentPrompt: "", discardBehavior: "record-only", mergeStrategy: "squash", mergeRunPullRequest: false, worktree: WORKTREE_OFF };

/** `runIdFactory` is fixed at `run_test`, so every run's session branch is this. */
const SESSION = "run/test";

interface FakePullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly mergeable?: "mergeable" | "conflicting" | "unknown";
  readonly mergeCommitSha?: string;
}

interface Harness {
  readonly engine: AutoRunEngine;
  readonly git: GitClient;
  readonly github: AutoRunGitHub;
  readonly notifications: string[];
  /** Messages the engine escalated because they need the user's hands. */
  readonly alerts: { readonly message: string; readonly url: string | undefined }[];
  readonly comments: { readonly issue: number; readonly body: string }[];
  /** Issues aboard closed itself, with the comment it closed them with. */
  readonly closures: { readonly issue: number; readonly body: string }[];
  readonly createdPullRequests: { readonly title: string; readonly body: string; readonly head: string; readonly base: string }[];
  readonly updatedPullRequests: { readonly number: number; readonly title: string; readonly body: string }[];
  /** Every merge the engine asked for, and whether it asked to delete the branch. */
  readonly merges: { readonly pr: number; readonly deleteBranch: boolean }[];
  readonly launches: DelegationLaunchInput[];
  readonly continuations: { readonly session: AgentSession; readonly prompt: string; readonly completionCommitStartingSha?: string; readonly reviewRange?: string }[];
  readonly closedTerminals: TerminalId[];
  /** Origins the engine declared for its handed-off launches; they decide the lease. */
  readonly interactiveOrigins: LaunchOrigin[];
  readonly gitCalls: string[];
  readonly commitCalls: { readonly subject: string; readonly body: string }[];
  readonly githubCalls: string[];
  readonly logs: string[];
  readonly saved: AutoRunRecord[];
  readonly states: AutoRunState[];
  readonly state: { cleared: boolean };
  readonly pullRequests: Map<number, FakePullRequest>;
  readonly setDirty: () => void;
  /** Simulates amending the one acceptance commit to include residual work. */
  readonly amendAcceptance: () => void;
  /** git methods called against the user's own checkout, in worktree mode. */
  readonly userGitCalls: string[];
  /** git methods called against the run's own checkout. */
  readonly workspaceGitCalls: string[];
  readonly released: RunWorkspaceOutcome[];
  readonly isolatedRoot: string;
  readonly closedPullRequests: number[];
  readonly recordedWorkspaceRemovals: string[];
  /** The record as the store holds it now. */
  readonly record: () => AutoRunRecord | undefined;
  readonly seed: (record: AutoRunRecord) => void;
  readonly branchExists: (branch: string) => boolean;
  readonly remoteBranchExists: (branch: string) => boolean;
  readonly sha: (branch: string) => string;
  /** Moves a branch, as a force-push or somebody else's commit would. */
  readonly advance: (branch: string) => void;
  /** Moves only origin, as a GitHub squash merge does while VS Code is closed. */
  readonly advanceRemote: (branch: string) => string;
  readonly closeIssue: (number: number) => void;
  /** Puts a branch in place locally and on origin, as a previous attempt would have. */
  readonly createBranch: (branch: string) => void;
  readonly relabel: (number: number, labels: string[]) => void;
}

interface QueueIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: string[];
  readonly state: "open" | "closed";
  readonly openBlockedByNumbers: number[];
  readonly dependencyNumbers?: readonly number[];
  /** Defaults to the issue number's own order when a test does not care. */
  readonly createdAt?: string;
}

interface HarnessOptions {
  readonly beforeFastForward?: (branch: string) => void;
  readonly hitlUncommitted?: boolean;
  readonly interruptBeforeSave?: (record: AutoRunRecord) => boolean;
  readonly settings?: Partial<AutoRunSettings>;
  /** The open issue queue the repository reports, in any order. */
  readonly issues?: readonly QueueIssue[];
  /** Whether a worker commits before it exits. Defaults to true. */
  readonly producesChanges?: boolean;
  readonly implementerFails?: boolean;
  readonly implementerFailsForIssue?: number;
  readonly exploreFails?: boolean;
  readonly explorationReport?: string;
  /** Final message returned by the implementer. */
  readonly implementerMessage?: string;
  /** Makes a worker leave residual uncommitted edits behind its commit. */
  readonly workerLeavesDirtyTree?: boolean;
  /** Makes a worker commit more than the one commit the protocol allows. */
  readonly workerCommitCount?: number;
  /** Whether the reviewer finds anything to fix. Defaults to `producesChanges`. */
  readonly reviewerProducesChanges?: boolean;
  /** Final message returned by the reviewer; semantics must not affect orchestration. */
  readonly reviewerMessage?: string;
  readonly reviewerFails?: boolean;
  /** Violates the HITL reviewer contract by moving HEAD. */
  readonly hitlReviewerCommits?: boolean;
  /** Simulates a reset implementation that failed to restore the index to beforeSha. */
  readonly resetLeavesStaged?: boolean;
  /** Whether the reviewer reaches a completed verdict and creates its required commit. */
  readonly reviewerCompletes?: boolean;
  /** Called once a hitl pull request has been observed as open; returns its next state. */
  readonly startDirty?: boolean;
  readonly pushFails?: boolean;
  readonly githubAuthenticationFails?: boolean;
  /** The branch checked out when the run starts. Defaults to `main`. */
  readonly startBranch?: string;
  /** Pull requests GitHub reports as conflicting with their base. */
  readonly conflicting?: boolean;
  /** Whether merging the base back in resolves that conflict. */
  readonly reconcilable?: boolean;
  /** Simulates branch protection: the merge is refused for a non-conflict reason. */
  readonly mergeRefused?: boolean;
  readonly commentFails?: boolean;
  readonly closeFails?: boolean;
  /** The run's target branch exists only locally, so no pull request can target it. */
  readonly baseNotOnRemote?: boolean;
  /** A stale remote target SHA, distinct from the local target branch. */
  readonly remoteBaseSha?: string;
  /** Local commits on the run target which origin does not contain. */
  readonly unpublishedTargetCommits?: number;
  /** The target's starting tip has been published by the time the final PR opens. */
  readonly targetPublishedBeforeConclusion?: boolean;
  /** Runs with a checkout of its own instead of the user's working tree. */
  readonly worktree?: boolean;
  /** Changes a frozen classification after the worker returns, before commit. */
  readonly relabelAfterImplementer?: boolean;
  /** Leaves this automated worker pending until the run aborts it. */
  readonly pendingWorkerType?: "implementer" | "reviewer" | "Explore";
  /** Adds controllable latency or failure to every remote-ref observation. */
  readonly fetch?: () => Promise<void>;
  /** Head branches GitHub reports as already having a pull request, before the run opens any. */
  readonly preExistingPullRequestBranches?: readonly string[];
  /** Review decision GitHub reports on the hitl pull request once it is waiting. */
  readonly hitlReviewDecision?: "approved" | "changes-requested" | "reviewed" | "unreviewed";
}

test("single-branch processes sequential AFK issues without issue branches or issue pull requests", async () => {
  const context = harness({
    settings: { branchMode: "single-branch" },
    issues: [
      { number: 34, title: "first", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
      { number: 35, title: "second", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
    ],
  });
  const started = await context.engine.start();
  assert.equal(started.started, true);
  await context.engine.settle();
  assert.equal(context.state.cleared, true, context.notifications.join("\n"));
  assert.equal(context.createdPullRequests.length, 1);
  assert.equal(context.createdPullRequests[0]?.head, SESSION);
  assert.equal(context.gitCalls.some((call) => call.includes("issue/34-") || call.includes("issue/35-")), false);
  assert.deepEqual(context.closures.map((closure) => closure.issue), [34, 35]);
});

test("single-branch HITL review resets the local checkpoint and reviews before acceptance or publication", async () => {
  const context = harness({
    hitlUncommitted: true,
    settings: { branchMode: "single-branch", review: true },
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  for (let attempt = 0; attempt < 100 && context.engine.state()?.waiting !== true; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(context.engine.state()?.waiting, true);
  assert.equal(context.closures.length, 0);
  assert.equal(context.engine.state()?.phase, "await-commit");
  assert.equal(context.createdPullRequests.length, 0, "the temporary implementation checkpoint is never published");
  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
  assert.ok(context.launches[0]?.completionCommitStartingSha, "the reviewed HITL implementer must create a checkpoint commit");
  assert.equal(context.launches[1]?.completionCommitStartingSha, undefined, "the HITL reviewer must leave the handoff uncommitted");
  assert.ok(context.gitCalls.some((call) => call.startsWith("resetMixed ")));
  const checkpoint = context.record()?.progress["35"];
  assert.ok(checkpoint?.state === "current" && checkpoint.implementerCommitSha && checkpoint.resetCompleted && checkpoint.hitlReviewCompleted);
  assert.equal(checkpoint.implementationSha, undefined);
  await context.git.add();
  await context.git.commit("User accepts", "");
  await context.engine.settle();
  assert.equal(context.state.cleared, true, context.notifications.join("\n"));
  const review = context.launches.find((launch) => launch.type === "reviewer");
  assert.ok(review, "reviewer should be launched");
  assert.deepEqual(context.closures.map((closure) => closure.issue), [35]);
  assert.equal(context.merges.length, 0, "the cumulative PR is not an issue-acceptance signal");
});

function harness(options: HarnessOptions = {}): Harness {
  const notifications: string[] = [];
  const alerts: { message: string; url: string | undefined }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const closures: { issue: number; body: string }[] = [];
  const merges: { pr: number; deleteBranch: boolean }[] = [];
  const launches: DelegationLaunchInput[] = [];
  const continuations: { session: AgentSession; prompt: string; completionCommitStartingSha?: string; reviewRange?: string }[] = [];
  const closedTerminals: TerminalId[] = [];
  const interactiveOrigins: LaunchOrigin[] = [];
  const gitCalls: string[] = [];
  const commitCalls: { subject: string; body: string }[] = [];
  const githubCalls: string[] = [];
  const logs: string[] = [];
  const saved: AutoRunRecord[] = [];
  const states: AutoRunState[] = [];
  const state = { cleared: false };
  const pullRequests = new Map<number, FakePullRequest>();
  // Head branches that already have a pull request before the run opens any,
  // for the start-time ownership conflict check.
  const preExistingPrBranches = new Set<string>(options.preExistingPullRequestBranches ?? []);
  const branches = new Set<string>(["main", "feature/wip"]);
  // What origin has. A branch the user never pushed exists locally and not here,
  // which is the difference a pull request base cares about.
  const remoteBranches = new Set<string>(options.baseNotOnRemote === true ? ["main"] : ["main", "feature/wip"]);
  const pushed = new Set<string>();
  /** A minimal commit graph, so ancestry answers come from history, not messages. */
  const parents = new Map<string, string>();
  const worktrees: { path: string; branch: string | undefined }[] = [];
  let currentBranch = options.startBranch ?? "main";
  let dirty = options.startDirty === true;
  let nextPr = 56;
  const shas = new Map<string, number>();
  const inheritedShas = new Map<string, string>();
  const remoteShas = new Map<string, string>();
  let indexTreeSha: string | undefined;
  function shaFor(branch: string): string {
    const inherited = inheritedShas.get(branch);
    if (inherited !== undefined) return inherited;
    const revision = shas.get(branch) ?? 0;
    return `${branch.replace(/[^a-z0-9]/gu, "")}${revision}`.padEnd(40, "0").slice(0, 40);
  }
  function advance(branch: string): void {
    inheritedShas.delete(branch);
    shas.set(branch, (shas.get(branch) ?? 0) + 1);
  }
  function commitOn(branch: string): string {
    const before = shaFor(branch);
    advance(branch);
    const after = shaFor(branch);
    parents.set(after, before);
    indexTreeSha = `tree-${after}`;
    pushed.delete(branch);
    return after;
  }
  function chain(sha: string): string[] {
    const walked: string[] = [];
    for (let current = parents.get(sha); current !== undefined; current = parents.get(current)) walked.push(current);
    return walked;
  }
  function aheadCount(from: string, to: string): number {
    const reachable = new Set([to, ...chain(to)]);
    let count = 0;
    for (let current: string | undefined = from; current !== undefined && !reachable.has(current); current = parents.get(current)) count += 1;
    return count;
  }
  function resolve(ref: string): string {
    return branches.has(ref) ? shaFor(ref) : ref;
  }
  function advanceRemote(branch: string): string {
    const revision = (shas.get(`${branch}:remote`) ?? 0) + 1;
    shas.set(`${branch}:remote`, revision);
    const sha = `${branch.replace(/[^a-z0-9]/gu, "")}remote${revision}`.padEnd(40, "0").slice(0, 40);
    remoteShas.set(branch, sha);
    return sha;
  }

  const queue = options.issues ?? [
    { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open" as const, openBlockedByNumbers: [] },
  ];
  const open = new Set(queue.filter((entry) => entry.state === "open").map((entry) => entry.number));

  const git: GitClient = {
    currentBranch: async () => currentBranch,
    defaultBranch: async () => "main",
    status: async (): Promise<GitStatus> => ({ branch: currentBranch, entries: dirty ? [{ status: "M", path: "src/a.ts" }] : [] }),
    codebase: async () => ({ sourceFileCount: 12, languages: ["ts"], commitCount: 40 }),
    headSha: async () => shaFor(currentBranch),
    branchExists: async (branch) => branches.has(branch),
    existingBranches: async (names) => ({
      local: new Set(names.filter((name) => branches.has(name))),
      remote: new Set(names.filter((name) => remoteBranches.has(name))),
    }),
    branchSha: async (branch) => branches.has(branch) ? shaFor(branch) : undefined,
    remoteBranchSha: async (branch) => remoteBranches.has(branch)
      ? branch === (options.startBranch ?? "main") && options.remoteBaseSha !== undefined
        ? options.remoteBaseSha
        : remoteShas.get(branch) ?? shaFor(branch)
      : undefined,
    aheadBehind: async (left, right) => {
      // Only the target-publication check asks about a remote-tracking ref.
      if (right.startsWith("origin/")) return { ahead: options.unpublishedTargetCommits ?? 0, behind: 0 };
      const [from, to] = [resolve(left), resolve(right)];
      return { ahead: aheadCount(from, to), behind: aheadCount(to, from) };
    },
    isAncestor: async (ancestor, descendant) => {
      // Only a commit this fake created has real ancestry; every other question
      // is about target publication, which the options describe.
      if (parents.has(descendant)) return ancestor === descendant || chain(descendant).includes(ancestor);
      return options.targetPublishedBeforeConclusion ?? (options.unpublishedTargetCommits === undefined);
    },
    treeSha: async (ref) => `tree-${resolve(ref)}`,
    commitDetails: async (ref) => ({ sha: resolve(ref), parents: [parents.get(resolve(ref)) ?? "parent0000000000000000000000000000000000"], subject: "subject", message: "subject", treeSha: `tree-${resolve(ref)}` }),
    stagedTreeSha: async () => indexTreeSha ?? `tree-${shaFor(currentBranch)}`,
    resetMixed: async (ref) => {
      gitCalls.push(`resetMixed ${ref}`);
      const previousHead = shaFor(currentBranch);
      inheritedShas.set(currentBranch, ref);
      indexTreeSha = `tree-${options.resetLeavesStaged === true ? previousHead : ref}`;
      dirty = true;
    },
    workingTreeMatchesCommit: async () => dirty,
    deleteBranchAt: async (branch, expected) => {
      gitCalls.push(`deleteBranchAt ${branch} ${expected}`);
      if (!branches.has(branch) || shaFor(branch) !== expected) return false;
      branches.delete(branch);
      return true;
    },
    deleteRemoteBranchAt: async (branch, expected) => {
      gitCalls.push(`deleteRemoteBranchAt ${branch} ${expected}`);
      if (!remoteBranches.has(branch) || shaFor(branch) !== expected) return false;
      remoteBranches.delete(branch);
      return true;
    },
    remoteBranchExists: async (branch) => remoteBranches.has(branch),
    fetch: async () => { gitCalls.push("fetch"); await options.fetch?.(); },
    checkout: async (branch) => { gitCalls.push(`checkout ${branch}`); currentBranch = branch; },
    createBranch: async (branch, from) => {
      gitCalls.push(`createBranch ${branch} ${from}`);
      const source = from.startsWith("origin/") ? from.slice("origin/".length) : from;
      inheritedShas.set(branch, branches.has(source) || remoteBranches.has(source) ? shaFor(source) : source);
      branches.add(branch);
      currentBranch = branch;
    },
    deleteBranch: async (branch) => { gitCalls.push(`deleteBranch ${branch}`); branches.delete(branch); inheritedShas.delete(branch); },
    fastForward: async (branch) => {
      gitCalls.push(`fastForward ${branch}`);
      options.beforeFastForward?.(branch);
      const remote = remoteShas.get(branch);
      if (remote !== undefined) inheritedShas.set(branch, remote);
    },
    mergeFromRemote: async (base) => {
      gitCalls.push(`mergeFromRemote ${base}`);
      if (options.reconcilable !== true) return false;
      // A reconciled branch is one GitHub will merge; the fake resolves every
      // conflicting pull request the same way a real base merge would.
      for (const [number, pr] of pullRequests) pullRequests.set(number, { ...pr, mergeable: "mergeable" });
      return true;
    },
    add: async () => { gitCalls.push("add"); },
    commit: async (subject, body) => { gitCalls.push("commit"); commitCalls.push({ subject, body }); dirty = false; return commitOn(currentBranch); },
    push: async (branch, setUpstream) => {
      gitCalls.push(`push ${branch}${setUpstream ? " -u" : ""}`);
      // The session branch's own push is infrastructure, not the issue's commit;
      // a `pushFails` test is about the latter.
      if (options.pushFails === true && branch !== SESSION) throw new Error("push rejected");
      const remote = remoteShas.get(branch);
      if (remote !== undefined && remote !== shaFor(branch) && !chain(shaFor(branch)).includes(remote)) throw new Error("non-fast-forward");
      pushed.add(branch);
      remoteBranches.add(branch);
      remoteShas.set(branch, shaFor(branch));
    },
    isPushed: async (branch) => pushed.has(branch),
    ignoredPaths: async (paths) => [...paths],
    trackedPathsUnder: async () => [],
    worktrees: async () => [...worktrees],
    addWorktree: async (path, branch, startPoint) => {
      gitCalls.push(`addWorktree ${path} ${branch}${startPoint === undefined ? "" : ` ${startPoint}`}`);
      branches.add(branch);
      worktrees.push({ path, branch });
    },
    removeWorktree: async (path, force) => {
      gitCalls.push(`removeWorktree ${path}${force ? " --force" : ""}`);
      const index = worktrees.findIndex((worktree) => worktree.path === path);
      if (index >= 0) worktrees.splice(index, 1);
    },
  };

  const github: AutoRunGitHub = {
    checkAuthentication: async () => {
      githubCalls.push("checkAuthentication");
      if (options.githubAuthenticationFails === true) throw new Error("GitHub CLI command failed");
    },
    listImplementableIssues: async () => {
      githubCalls.push("listImplementableIssues");
      const candidates = queue.filter((entry) => open.has(entry.number)).map((entry) => ({
        number: entry.number,
        title: entry.title,
        labels: entry.labels,
        state: "open" as const,
        openBlockedByNumbers: entry.openBlockedByNumbers.filter((number) => open.has(number)),
        dependencyNumbers: (entry.dependencyNumbers ?? entry.openBlockedByNumbers)
          .filter((number) => open.has(number)),
        createdAt: entry.createdAt ?? `2026-01-${String(entry.number % 28 + 1).padStart(2, "0")}T00:00:00.000Z`,
      }));
      return { candidates };
    },
    getIssue: async (number) => ({
      state: open.has(number) ? "open" as const : "closed" as const,
      labels: queue.find((entry) => entry.number === number)?.labels ?? [],
      comments: comments.filter((entry) => entry.issue === number),
    }),
    addIssueComment: async (number, body) => {
      if (options.commentFails === true) throw new Error("gh issue comment failed");
      comments.push({ issue: number, body });
    },
    closeIssue: async (number, comment) => {
      if (options.closeFails === true) throw new Error("gh issue close failed");
      closures.push({ issue: number, body: comment });
      open.delete(number);
    },
    createPullRequest: async () => {
      const number = nextPr++;
      pullRequests.set(number, { state: "open", mergeable: options.conflicting === true ? "conflicting" : "mergeable" });
      return number;
    },
    findOpenPullRequestForBranch: async (branch) => {
      for (const [number, pr] of pullRequests) {
        if (pr.state === "open" && number === prForBranch(branch)) return number;
      }
      return undefined;
    },
    findPullRequestForBranch: async (branch) => prForBranch(branch) ?? (preExistingPrBranches.has(branch) ? 900 : undefined),
    findPullRequestsByHead: async (names) => {
      const found = new Map<string, number>();
      for (const name of names) {
        const number = prForBranch(name) ?? (preExistingPrBranches.has(name) ? 900 : undefined);
        if (number !== undefined) found.set(name, number);
      }
      return found;
    },
    getPullRequest: async (number) => {
      const pr = pullRequests.get(number);
      return pr === undefined ? undefined : {
        ...pr,
        number,
        mergeable: pr.mergeable ?? "mergeable",
        url: `https://github.com/acme/app/pull/${number}`,
        headBranch: branchesByPr.get(number) ?? "",
        baseBranch: basesByPr.get(number) ?? "",
        headSha: shaFor(branchesByPr.get(number) ?? ""),
        // The decision rides in the same snapshot; an unreviewed pull request
        // reports none rather than omitting the field.
        reviewDecision: pr.state === "open" && isHitl(number) ? options.hitlReviewDecision ?? "unreviewed" : "unreviewed",
        ...(pr.mergeCommitSha === undefined ? {} : { mergeCommitSha: pr.mergeCommitSha }),
      };
    },
    getReviewState: async () => ({ decision: "unreviewed" }),
    mergePullRequest: async (number, _strategy, deleteBranch) => {
      const pr = pullRequests.get(number);
      merges.push({ pr: number, deleteBranch });
      if (options.mergeRefused === true) throw new Error("Protected branch rules not met");
      if (pr?.mergeable === "conflicting") throw new Error("Pull request is not mergeable");
      // The merge moves the base branch, exactly as a real one does.
      const base = basesByPr.get(number);
      const mergedSha = base === undefined ? undefined : advanceRemote(base);
      pullRequests.set(number, { state: "merged", ...(mergedSha === undefined ? {} : { mergeCommitSha: mergedSha }) });
    },
    closePullRequestIf: async (number, expected) => {
      const pr = pullRequests.get(number);
      if (pr?.state !== "open") return false;
      if (branchesByPr.get(number) !== expected.head || basesByPr.get(number) !== expected.base) return false;
      pullRequests.set(number, { state: "closed" });
      closedPullRequests.push(number);
      return true;
    },
  };

  const branchesByPr = new Map<number, string>();
  const basesByPr = new Map<number, string>();
  const closedPullRequests: number[] = [];
  function prForBranch(branch: string): number | undefined {
    for (const [number, value] of branchesByPr) if (value === branch) return number;
    return undefined;
  }
  function issueForBranch(branch: string): number {
    return Number(/^issue\/(\d+)-/.exec(branch)?.[1] ?? 0);
  }
  function issueForPr(number: number): number {
    return issueForBranch(branchesByPr.get(number) ?? "");
  }
  function isHitl(number: number): boolean {
    return queue.find((entry) => entry.number === issueForPr(number))?.labels.includes("[AI]-hitl") === true;
  }

  const launcher: AutoRunLauncher = {
    runAutomated: async (input, signal) => {
      launches.push(input);
      // implement and review signal completion by committing;
      // Explore is read-only.
      if (input.type === options.pendingWorkerType) {
        // Killed mid-edit: what it had written is still uncommitted.
        if (input.type !== "Explore" && options.producesChanges !== false) dirty = true;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          agentId: `agent-${launches.length}` as AgentId,
          sessionId: "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId,
          terminalId: `terminal-${launches.length}` as TerminalId,
          result: { outcome: "failed", failure: { type: "killed", exitCode: null, lastAssistantMessage: null }, telemetry: telemetry() },
        };
      }
      const commits = input.type === "reviewer"
        ? input.completionCommitStartingSha !== undefined && options.reviewerCompletes !== false && options.reviewerFails !== true
        : input.completionCommitStartingSha !== undefined && options.producesChanges !== false;
      if (input.type === "implementer" && input.completionCommitStartingSha === undefined && options.hitlUncommitted) dirty = true;
      else if (input.type === "reviewer" && input.completionCommitStartingSha === undefined && options.hitlReviewerCommits === true) {
        commitOn(currentBranch);
        dirty = false;
      }
      else if (input.type === "reviewer" && input.completionCommitStartingSha === undefined && options.reviewerProducesChanges === true) dirty = true;
      else if (input.type !== "Explore" && commits) {
        for (let made = 0; made < (options.workerCommitCount ?? 1); made += 1) commitOn(currentBranch);
        if (options.workerLeavesDirtyTree === true) dirty = true;
      }
      if (input.type === "implementer" && options.relabelAfterImplementer === true) {
        queue.find((entry) => entry.number === input.issues?.[0])?.labels.splice(0, Infinity, "[AI]-hitl");
      }
      const implementer = input.type === "implementer";
      const failed = (implementer && (
        options.implementerFails === true
        || options.implementerFailsForIssue === input.issues?.[0]
      ))
        || (input.type === "Explore" && options.exploreFails === true)
        || (input.type === "reviewer" && options.reviewerFails === true);
      return {
        agentId: `agent-${launches.length}` as AgentId,
        sessionId: "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId,
        terminalId: `terminal-${launches.length}` as TerminalId,
        result: failed
          ? { outcome: "failed", failure: { type: "context-exhausted", exitCode: 1, lastAssistantMessage: null }, telemetry: telemetry() }
          : {
              outcome: "succeeded",
              exitCode: 0,
              lastAssistantMessage: implementer
                ? options.implementerMessage ?? "Addressed the issue.\n\n<commit>Implement requested change</commit>"
                : input.type === "Explore"
                  ? options.explorationReport ?? "Relevant code lives in src/retry.ts; verify with retry tests."
                  : options.reviewerMessage ?? "Addressed the issue.",
              telemetry: telemetry(),
            },
      };
    },
    resumeAutomated: async (session, prompt, _difficulty, _signal, completionCommitStartingSha, reviewRange) => {
      // A continued worker finishes the job the original one did not.
      continuations.push({ session, prompt,
        ...(completionCommitStartingSha === undefined ? {} : { completionCommitStartingSha }),
        ...(reviewRange === undefined ? {} : { reviewRange }) });
      if (completionCommitStartingSha !== undefined) commitOn(currentBranch);
      return {
        agentId: session.identity.agentId,
        sessionId: session.sessionId,
        terminalId: "terminal-continued" as TerminalId,
        result: {
          outcome: "succeeded",
          exitCode: 0,
          lastAssistantMessage: "Finished the issue.\n\n<commit>Complete requested change</commit>",
          telemetry: telemetry(),
        },
      };
    },
    launchInteractive: async (input, origin) => {
      launches.push(input);
      interactiveOrigins.push(origin);
      return {
        agentId: `agent-${launches.length}` as AgentId,
        sessionId: "0f9e8d7c-6b5a-4938-8271-6a5b4c3d2e1f" as SessionId,
        terminalId: `terminal-${launches.length}` as TerminalId,
      };
    },
  };

  // The engine creates the PR before it knows the branch mapping, so record it
  // as each pull request is opened.
  const createdPullRequests: { title: string; body: string; head: string; base: string }[] = [];
  const updatedPullRequests: { number: number; title: string; body: string }[] = [];
  const pullRequestText = new Map<number, { title: string; body: string }>();
  const wrappedGithub: AutoRunGitHub = {
    ...github,
    getPullRequest: async (number) => {
      const snapshot = await github.getPullRequest(number);
      return snapshot === undefined ? undefined : { ...snapshot, ...pullRequestText.get(number) };
    },
    updatePullRequest: async (number, input) => { updatedPullRequests.push({ number, ...input }); pullRequestText.set(number, input); },
    createPullRequest: async (input) => {
      const number = await github.createPullRequest(input);
      branchesByPr.set(number, input.head);
      basesByPr.set(number, input.base);
      createdPullRequests.push({ ...input });
      pullRequestText.set(number, input);
      return number;
    },
  };

  const userGitCalls: string[] = [];
  const workspaceGitCalls: string[] = [];
  const released: RunWorkspaceOutcome[] = [];
  const recordedWorkspaceRemovals: string[] = [];
  const trace = (client: GitClient, into: string[]): GitClient => new Proxy(client, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: readonly unknown[]) => {
        into.push(String(property));
        return (value as (...rest: readonly unknown[]) => unknown).call(target, ...args);
      };
    },
  });
  const isolatedRoot = "C:/checkouts/aboard-1";
  const workspaces: RunWorkspaceProvider = {
    isolates: () => true,
    nextRoot: () => isolatedRoot,
    prepare: async () => ({
      root: isolatedRoot,
      git: trace(git, workspaceGitCalls),
      denyTools: [`Read(//C:/work/aboard/**)`],
      writableRoots: ["C:/work/aboard/.git/worktrees/session"],
      isolated: true,
      keepAfterDrain: false,
    }),
    release: async (_workspace, outcome) => { released.push(outcome); return undefined; },
    removeRecorded: async (root) => { recordedWorkspaceRemovals.push(root); return true; },
  };

  let stored: AutoRunRecord | undefined;
  const engine = new AutoRunEngine({
    workspaceRoot: "C:/work/aboard",
    git: options.worktree === true ? trace(git, userGitCalls) : git,
    gitFor: (cwd) => cwd === isolatedRoot ? trace(git, workspaceGitCalls) : trace(git, userGitCalls),
    ...(options.worktree === true ? { workspaces } : {}),
    github: wrappedGithub,
    launcher,
    terminals: { close: (terminalId) => { closedTerminals.push(terminalId); } },
    store: {
      load: async () => stored,
      // The store is a real one, not a sink: fixed-plan recovery re-reads what
      // the engine wrote, so a fake that forgets would test nothing.
      save: async (record) => {
        if (record.version !== 4) throw new Error("the engine must only ever write version-4 records");
        if (options.interruptBeforeSave?.(record)) throw new Error("simulated extension interruption");
        stored = record;
        saved.push(record);
      },
      clear: async () => { stored = undefined; state.cleared = true; },
    },
    notifier: {
      notify: (message) => notifications.push(message),
      alert: (message, url) => { notifications.push(message); alerts.push({ message, url }); },
    },
    log: (message) => logs.push(message),
    settings: () => ({ ...SETTINGS, ...options.settings }),
    runIdFactory: () => "run_test",
    // A macrotask, not an immediately-resolved promise: a microtask-only poll
    // would starve the event loop and never observe an abort.
    sleep: () => new Promise((resolve) => { setImmediate(resolve); }),
    onStateChange: (next) => { if (next !== undefined) states.push(next); },
    pathExists: () => true,
  });

  return {
    engine,
    git,
    github: wrappedGithub,
    notifications,
    alerts,
    comments,
    closures,
    merges,
    createdPullRequests,
    launches,
    continuations,
    closedTerminals,
    interactiveOrigins,
    gitCalls,
    commitCalls,
    githubCalls,
    logs,
    saved,
    states,
    state,
    pullRequests,
    setDirty: () => { dirty = true; },
    amendAcceptance: () => { dirty = false; },
    userGitCalls,
    workspaceGitCalls,
    released,
    isolatedRoot,
    closedPullRequests,
    recordedWorkspaceRemovals,
    updatedPullRequests,
    record: () => stored,
    seed: (record: AutoRunRecord) => { stored = record; },
    branchExists: (branch: string) => branches.has(branch),
    remoteBranchExists: (branch: string) => remoteBranches.has(branch),
    sha: (branch: string) => shaFor(branch),
    advance,
    advanceRemote,
    closeIssue: (number: number) => open.delete(number),
    createBranch: (branch: string) => { branches.add(branch); remoteBranches.add(branch); },
    relabel: (number: number, labels: string[]) => {
      const entry = queue.find((candidate) => candidate.number === number);
      if (entry !== undefined) entry.labels.splice(0, entry.labels.length, ...labels);
    },
  };
}

async function waitForLaunch(context: Harness, type: DelegationLaunchInput["type"]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (context.launches.some((launch) => launch.type === type)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`${type} was not launched`);
}

function endedWorkerSession(record: AutoRunRecord, issueNumber: number, terminalId: string): AgentSession {
  const reference = record.workerSession;
  assert.ok(reference);
  return {
    platform: "claude",
    identity: { agentId: reference.agentId, type: reference.type },
    sessionId: reference.sessionId,
    sessionBinding: "bound",
    terminal: { terminalId: terminalId as TerminalId, name: `aboard: ${reference.type} issue ${issueNumber}` },
    lifecycle: {
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
      finishedAt: "2026-01-01T00:01:00.000Z" as IsoTimestamp,
      failure: { type: "context-exhausted", exitCode: 1, lastAssistantMessage: null },
    },
    resultDelivery: { mode: "tool-result" },
    telemetry: telemetry(),
    issueNumbers: [issueNumber],
    autoRunRestricted: true,
  };
}

function plannedRecord(overrides: Partial<AutoRunRecord> = {}): AutoRunRecord {
  return {
    version: 4,
    runId: "run_test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempt: 1,
    settings: {
      review: false,
      exploreBeforeImplement: false,
      issueContextDepth: 1,
      mergeStrategy: "squash",
      mergeRunPullRequest: false,
      worktree: WORKTREE_OFF,
    },
    plan: [{ number: 34, title: "Add retry backoff", branch: "issue/34-add-retry-backoff", disposition: "afk", dependsOn: [] }],
    progress: { "34": { state: "pending" } },
    sessionBranch: SESSION,
    targetBranch: "main",
    branchShas: {},
    currentIssue: undefined,
    checkpoint: "planned",
    reviewedIssues: [],
    ...overrides,
  };
}

function telemetry() {
  return { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 };
}

test("run observation distinguishes an unusable checkout from an unavailable fetch", async () => {
  const context = harness();
  let fetched = false;
  const unusable = await observeRun(plannedRecord(), {
    git: {
      ...context.git,
      status: async () => { throw new Error("not a repository"); },
      fetch: async () => { fetched = true; },
    },
    github: context.github,
  });
  assert.equal(unusable.repositoryUsable, false);
  assert.equal(fetched, false, "a checkout that failed locally is not fetched");

  await assert.rejects(
    observeRun(plannedRecord(), {
      git: { ...context.git, fetch: async () => { throw new Error("remote ref lock busy"); } },
      github: context.github,
    }),
    /remote ref lock busy/,
  );
});

test("all run observations serialize their ref-mutating fetches", async () => {
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  const context = harness({
    fetch: async () => {
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      activeFetches -= 1;
    },
  });
  context.seed(plannedRecord());

  await Promise.all([
    context.engine.refresh(),
    context.engine.planDiscard("record-only"),
  ]);

  assert.equal(maximumActiveFetches, 1);
});

test("GitHub failures retain their diagnostic without credential-bearing URLs", async () => {
  const context = harness();
  context.seed(plannedRecord());
  context.github.listImplementableIssues = async () => {
    throw new GitHubBoundaryError("command-failed", "GitHub CLI command failed", {
      stderr: "\ngh: request failed https://user:secret@example.com/graphql\nsecond line",
    });
  };
  assert.deepEqual(await context.engine.refresh(), { state: "checking" });
  assert.equal(context.record()?.outcome?.kind, "interrupted");
  assert.ok(context.logs.some((line) => line.endsWith("GitHub CLI command failed: gh: request failed <remote>")));
  assert.doesNotMatch(context.logs.join("\n"), /secret|second line/);
});

test("a transient recovery fetch failure stays unavailable rather than becoming broken", async () => {
  const context = harness({
    fetch: async () => {
      throw new GitBoundaryError("command-failed", "git fetch failed", {
        stderr: "fatal: cannot lock ref 'refs/remotes/origin/run/test'",
      });
    },
  });
  const record = plannedRecord();
  context.seed(record);

  assert.deepEqual(await context.engine.refresh(), { state: "checking" });
  assert.equal(context.record()?.outcome?.kind, "interrupted", "the recoverable run record survives an unavailable observation");
  assert.match(context.logs.join("\n"), /recovery check unavailable: git fetch failed: fatal: cannot lock ref/);
});

test("the afk path runs branch to merge and performs every side effect itself", async () => {
  const context = harness();
  const result = await context.engine.start();
  assert.equal(result.started, true);
  await context.engine.settle();
  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
  assert.equal(context.launches[0]?.issueContextDepth, 1);
  assert.equal(context.launches[0]?.description, "address issue 34");
  assert.deepEqual(context.gitCalls.filter((call) => call !== "fetch"), [
    // The session branch carries the user's local branch, including commits not
    // published yet, and is published before any issue starts.
    `createBranch ${SESSION} main`, `push ${SESSION} -u`,
    `checkout ${SESSION}`, `fastForward ${SESSION}`, `createBranch issue/34-add-retry-backoff ${SESSION}`,
    // implement made the commit itself; aboard only publishes it.
    "push issue/34-add-retry-backoff -u",
    // After the merge, so the record carries the session branch tip the merge
    // produced rather than the one it had before.
    `checkout ${SESSION}`, `fastForward ${SESSION}`,
    `checkout ${SESSION}`,
    `deleteBranchAt issue/34-add-retry-backoff ${context.sha("issue/34-add-retry-backoff")}`,
    `deleteRemoteBranchAt issue/34-add-retry-backoff ${context.sha("issue/34-add-retry-backoff")}`,
    "checkout main",
  ]);
  assert.equal(context.pullRequests.get(56)?.state, "merged");
  assert.match(context.notifications.join("\n"), /issue #34 committed \([0-9a-z]+\) and opened PR #56/);
  assert.match(context.notifications.join("\n"), new RegExp(`issue #34 merged into ${SESSION}`));
  assert.deepEqual(context.closedTerminals, ["terminal-1"], "the successful implementer is closed as soon as its result is accepted");
  assert.equal(context.state.cleared, true);
});

test("optional exploration runs just before a fresh implementer and publishes its complete context", async () => {
  const report = `Relevant code lives in src/retry.ts; preserve RetryPolicy and run retry tests.\n${"x".repeat(7_000)}`;
  const context = harness({
    settings: { exploreBeforeImplement: true, issueContextDepth: 2 },
    explorationReport: report,
  });

  const result = await context.engine.start();
  assert.equal(result.started, true);
  assert.equal(result.started && result.exploresBeforeImplement, true);
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["Explore", "implementer"]);
  assert.equal(context.launches[0]?.issues?.[0], 34);
  assert.equal(context.launches[0]?.issueContextDepth, 2);
  assert.equal(context.launches[1]?.codebaseContext, report);
  assert.equal(context.saved.some((record) => record.settings.exploreBeforeImplement), true);
  assert.equal(context.states.some((state) => state.phase === "explore"), true);
  assert.match(context.comments[0]?.body ?? "", /^## Codebase context\n/);
  assert.doesNotMatch(context.comments[0]?.body ?? "", /<!--|aboard|abd\//iu);
  assert.match(context.comments[0]?.body ?? "", /Relevant code lives in src\/retry\.ts/);
  assert.deepEqual(context.closedTerminals.slice(0, 2), ["terminal-1", "terminal-2"]);
});

test("single-branch exploration is repeated immediately before each fresh implementer", async () => {
  const context = harness({
    settings: { branchMode: "single-branch", exploreBeforeImplement: true },
    issues: [
      { number: 34, title: "first", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
      { number: 35, title: "second", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
    ],
  });

  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["Explore", "implementer", "Explore", "implementer"]);
  assert.deepEqual(context.launches.map((launch) => launch.issues?.[0]), [34, 34, 35, 35]);
});

test("Explore failure stops recoverably before implementation", async () => {
  const context = harness({ settings: { exploreBeforeImplement: true }, exploreFails: true });

  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["Explore"]);
  assert.equal(context.gitCalls.includes("commit"), false);
  assert.equal(context.record()?.workerSession?.type, "Explore");
  assert.equal(context.record()?.workerSession?.continuable, undefined);
  const outcome = context.record()?.outcome;
  assert.match(outcome?.kind === "failed" ? outcome.reason : "", /Explore failed/);
});

test("exploration comment failure does not withhold direct context", async () => {
  const context = harness({ settings: { exploreBeforeImplement: true }, commentFails: true });

  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["Explore", "implementer"]);
  assert.match(context.launches[1]?.codebaseContext ?? "", /Relevant code lives/);
  assert.match(context.logs.join("\n"), /could not comment on issue/);
});

test("resume creates a missing session branch from the unpublished local target", async () => {
  const context = harness({
    remoteBaseSha: "f".repeat(40),
    // The implementer commits nothing, so the run stops right after the session
    // branch is created and its recorded tip stays the one under test.
    producesChanges: false,
  });
  context.seed(plannedRecord({ checkpoint: "workspace-ready" }));

  assert.equal((await context.engine.resume()).started, true);
  await context.engine.settle();

  assert.ok(context.gitCalls.includes(`createBranch ${SESSION} main`), context.gitCalls.join(", "));
  assert.equal(context.record()?.branchShas[SESSION], context.sha("main"));
  assert.notEqual(context.record()?.branchShas[SESSION], "f".repeat(40));
});

test("auto-run freezes the issue-context depth and passes it only as launch data", async () => {
  const context = harness({ settings: { issueContextDepth: 3 } });
  const result = await context.engine.start();
  assert.equal(result.started, true);
  await context.engine.settle();

  assert.equal(context.saved.some((record) => record.settings.issueContextDepth === 3), true);
  assert.equal(context.launches[0]?.issueContextDepth, 3);
});

test("the default branch is never a pull request base and never merged into", async () => {
  const context = harness({ startBranch: "feature/wip" });
  await context.engine.start();
  await context.engine.settle();

  // Every issue targets the session branch; only the run's own pull request
  // targets a branch a human owns, and it is the one aboard did not merge.
  assert.deepEqual(context.createdPullRequests.map((pr) => pr.base), [SESSION, "feature/wip"]);
  assert.equal(context.gitCalls.some((call) => call.startsWith("checkout main")), false);
  assert.deepEqual(context.merges, [{ pr: 56, deleteBranch: false }]);
});

test("an issue merged into the session branch is closed by aboard, because GitHub will not", async () => {
  const context = harness();
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.closures.map((closure) => closure.issue), [34]);
  assert.match(context.closures[0]?.body ?? "", new RegExp(SESSION.replace("/", "\\/")));
  // The closure is aboard's own doing, so it is said out loud rather than
  // implied by the merge line.
  assert.match(context.notifications.join("\n"), /issue #34 closed by aboard/);
  assert.match(context.notifications.join("\n"), new RegExp(`issue #34 merged into ${SESSION}`));
});

test("an issue that cannot be closed is reported instead of failing work that merged", async () => {
  const context = harness({ closeFails: true });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.pullRequests.get(56)?.state, "merged");
  assert.match(context.notifications.join("\n"), /issue #34 merged but could not be closed .*Close it yourself/);
  assert.match(context.notifications.join("\n"), /plan drained \(1 issue addressed\)/);
});

test("a dependent issue is unblocked within the run by the closure of the issue it waits on", async () => {
  const context = harness({
    issues: [
      { number: 33, title: "Blocked first", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [34], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 34, title: "Unblock it", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.filter((launch) => launch.type === "implementer").map((launch) => launch.issues?.[0]), [34, 33]);
  assert.deepEqual(context.closures.map((closure) => closure.issue), [34, 33]);
  assert.match(context.notifications.join("\n"), /plan drained \(2 issues addressed\)/);
});

test("the run opens one pull request into the user's branch and leaves it for them by default", async () => {
  const context = harness({
    startBranch: "feature/wip",
    issues: [
      { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 35, title: "Trim the cache", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  const runPr = context.createdPullRequests.at(-1);
  assert.equal(runPr?.head, SESSION);
  assert.equal(runPr?.base, "feature/wip");
  assert.match(runPr?.body ?? "", /- #34 Add retry backoff \(PR #56\)/);
  assert.match(runPr?.body ?? "", /- #35 Trim the cache \(PR #57\)/);
  assert.equal(context.pullRequests.get(58)?.state, "open", "the run's own pull request is not merged by default");
  assert.match(context.notifications.join("\n"), /opened PR #58 into feature\/wip with 2 issues/);
  // A pull request nobody is watching for is not progress, so it is escalated.
  assert.match(context.alerts.at(-1)?.message ?? "", /PR #58 into feature\/wip is yours to merge/);
});

test("the run merges its own pull request only when the setting allows it", async () => {
  const context = harness({ startBranch: "feature/wip", settings: { mergeRunPullRequest: true } });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.pullRequests.get(57)?.state, "merged");
  // The session branch survives: parked or unmerged issue pull requests still
  // target it, and deleting a base branch closes them.
  assert.deepEqual(context.merges, [{ pr: 56, deleteBranch: false }, { pr: 57, deleteBranch: false }]);
  assert.match(context.notifications.join("\n"), /PR #57 merged into feature\/wip\. Pull feature\/wip/);
});

test("a failed run leaves its partial run pull request open even when automatic merge is enabled", async () => {
  const context = harness({
    startBranch: "feature/wip",
    settings: { mergeRunPullRequest: true },
    issues: [
      { number: 34, title: "land first", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
      { number: 35, title: "fail second", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
    ],
    implementerFailsForIssue: 35,
  });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.pullRequests.get(57)?.state, "open");
  assert.deepEqual(context.merges, [{ pr: 56, deleteBranch: false }]);
  assert.equal(context.record()?.outcome?.kind, "failed");
});

test("unpublished target commits are frozen, warned about, and included in the final PR guidance", async () => {
  const context = harness({ startBranch: "feature/wip", unpublishedTargetCommits: 2 });

  const preview = await context.engine.dryRun();
  assert.equal(preview.inspected, true);
  if (!preview.inspected) return;
  assert.equal(preview.unpublishedTargetCommits, 2);
  assert.match(preview.warnings.join("\n"), /2 commits not on origin\/feature\/wip/);

  const started = await context.engine.startPreviewed(preview);
  assert.equal(started.started, true);
  await context.engine.settle();

  assert.equal(context.saved[0]?.unpublishedTargetCommits, 2);
  assert.equal(context.saved[0]?.targetHeadSha, context.sha("feature/wip"));
  assert.match(context.createdPullRequests.at(-1)?.body ?? "", /started with 2 commits on `feature\/wip`/);
  assert.match(context.notifications.join("\n"), /Push feature\/wip before squash\/rebase merging/);
});

test("automatic squash leaves the final PR open while its target commits are unpublished", async () => {
  const context = harness({
    startBranch: "feature/wip",
    unpublishedTargetCommits: 2,
    settings: { mergeRunPullRequest: true, mergeStrategy: "squash" },
  });

  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.pullRequests.get(57)?.state, "open");
  assert.deepEqual(context.merges, [{ pr: 56, deleteBranch: false }]);
  assert.match(context.alerts.map((alert) => alert.message).join("\n"), /left open.*squash would rewrite their ancestry/);
  assert.match(context.record()?.outcome?.kind ?? "", /failed/);
});

test("publishing the target during the run makes its configured final squash safe", async () => {
  const context = harness({
    startBranch: "feature/wip",
    unpublishedTargetCommits: 2,
    targetPublishedBeforeConclusion: true,
    settings: { mergeRunPullRequest: true, mergeStrategy: "squash" },
  });

  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.pullRequests.get(57)?.state, "merged");
  assert.deepEqual(context.merges.map((merge) => merge.pr), [56, 57]);
});

test("a merge commit preserves unpublished target ancestry and may land automatically", async () => {
  const context = harness({
    startBranch: "feature/wip",
    unpublishedTargetCommits: 2,
    settings: { mergeRunPullRequest: true, mergeStrategy: "merge" },
  });

  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.pullRequests.get(57)?.state, "merged");
  assert.deepEqual(context.merges.map((merge) => merge.pr), [56, 57]);
});

test("the run's own pull request is reconciled when it conflicts with the user's branch", async () => {
  const context = harness({
    startBranch: "feature/wip",
    settings: { mergeRunPullRequest: true },
    conflicting: true,
    reconcilable: true,
  });
  await context.engine.start();
  await context.engine.settle();

  const calls = context.gitCalls;
  assert.ok(calls.lastIndexOf(`fastForward ${SESSION}`) < calls.lastIndexOf("mergeFromRemote feature/wip"));
  assert.equal(calls.includes(`push ${SESSION}`), true);
  assert.equal(context.pullRequests.get(57)?.state, "merged");
});

test("a run's pull request that will not merge is left open with the reason", async () => {
  const context = harness({
    startBranch: "feature/wip",
    settings: { mergeRunPullRequest: true },
    conflicting: true,
    reconcilable: false,
  });
  await context.engine.start();
  await context.engine.settle();

  // #34's conflict stops the whole run, so nothing lands and there is no run
  // pull request to merge; the alert is about the issue that would not merge.
  assert.match(
    context.alerts.map((alert) => alert.message).join("\n"),
    new RegExp(`PR #56 conflicts with ${SESSION} and the conflict is not one aboard can resolve`),
  );
  assert.deepEqual(context.createdPullRequests.map((pr) => pr.base), [SESSION]);
});

test("a run that landed nothing opens no pull request", async () => {
  const context = harness({ implementerFails: true, producesChanges: false });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.createdPullRequests, []);
});

test("a target branch that is not on origin still leaves the work pushed and says so", async () => {
  const context = harness({ startBranch: "feature/wip", baseNotOnRemote: true });
  await context.engine.start();
  await context.engine.settle();

  // The session branch is cut locally, and the run refuses to push the user's
  // branch on their behalf just to have a pull request base.
  assert.equal(context.gitCalls.includes(`createBranch ${SESSION} feature/wip`), true);
  assert.equal(context.gitCalls.includes("push feature/wip"), false);
  assert.match(context.notifications.join("\n"), /feature\/wip is not on origin/);
  assert.match(context.alerts.map((alert) => alert.message).join("\n"), new RegExp(`work is committed and pushed on ${SESSION.replace("/", "\\/")}`));
  assert.equal(context.createdPullRequests.filter((pr) => pr.head === SESSION).length, 0);
});

test("[AI]-chrome is frozen per issue and reaches that issue's implementer only", async () => {
  const context = harness({
    settings: { review: true },
    issues: [{ number: 34, title: "Add retry backoff", labels: ["[AI]-afk", "[AI]-chrome"], state: "open", openBlockedByNumbers: [] }],
  });
  const result = await context.engine.start();
  assert.equal(result.started && result.issues[0]?.chrome, true);
  await context.engine.settle();

  assert.equal(context.launches[0]?.type, "implementer");
  assert.equal(context.launches[0]?.chrome, true);
  assert.equal(context.launches[1]?.type, "reviewer");
  assert.equal(context.launches[1]?.chrome, undefined);
  assert.equal(context.saved.every((record) => record.plan[0]?.chrome === true), true);
});

test("configured and per-run guidance are persisted and reach every auto agent separately", async () => {
  const context = harness({ settings: { review: true, permanentPrompt: "  run browser tests  " } });
  await context.engine.start({ additionalGuideline: "  no unit tests needed  " });
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
  assert.deepEqual(context.launches.map((launch) => launch.permanentPrompt), ["run browser tests", "run browser tests"]);
  assert.deepEqual(context.launches.map((launch) => launch.additionalGuideline), ["no unit tests needed", "no unit tests needed"]);
  assert.equal(context.saved.every((record) => record.settings.permanentPrompt === "run browser tests"), true);
  assert.equal(context.saved.every((record) => record.settings.additionalGuideline === "no unit tests needed"), true);
});

test("a run started off the default branch returns there when it ends", async () => {
  const context = harness({ startBranch: "feature/wip" });
  assert.equal((await context.engine.start()).started, true);
  await context.engine.settle();

  const calls = context.gitCalls;
  assert.equal(calls[calls.length - 1], "checkout feature/wip", "the last checkout lands back on the branch the run started from");
  assert.match(context.notifications.join("\n"), /auto-run: back on feature\/wip/);
});

test("the end-of-run restore does not trigger on the mid-run cleanup checkout", async () => {
  const context = harness({ startBranch: "feature/wip" });
  await context.engine.start();
  await context.engine.settle();

  const cleanups = context.gitCalls.filter((call) => call === "checkout feature/wip");
  assert.equal(cleanups.length, 1, "only the terminal restore touches the original branch; per-issue cleanup still uses the default");
});

test("a failed run keeps its current branch active when the tree is clean", async () => {
  // A failed implementer stops the run; even without edits, its issue branch is
  // the useful place for the user to inspect and fix the failure.
  const context = harness({ startBranch: "feature/wip", implementerFails: true, producesChanges: false });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /implementer failed/);
  assert.equal(context.gitCalls.includes("checkout feature/wip"), false);
});

test("a stop with uncommitted work does not check out over it", async () => {
  const context = harness({ startBranch: "feature/wip", implementerFails: true });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /implementer failed/);
  assert.equal(context.gitCalls.includes("checkout feature/wip"), false);
});

test("a user cancellation still restores the original branch", async () => {
  const context = harness({
    startBranch: "feature/wip",
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  context.engine.stop();
  await context.engine.settle();

  assert.equal(await context.git.currentBranch(), "feature/wip");
});

test("cancelling a running implementer settles its terminal and records cancellation", async () => {
  const context = harness({
    startBranch: "feature/wip",
    producesChanges: false,
    pendingWorkerType: "implementer",
  });
  await context.engine.start();
  await waitForLaunch(context, "implementer");

  context.engine.stop();
  await context.engine.settle();

  assert.deepEqual(context.record()?.outcome, { kind: "cancelled" });
  assert.deepEqual(context.closedTerminals, ["terminal-1"]);
  assert.equal(await context.git.currentBranch(), "issue/34-add-retry-backoff");
  assert.doesNotMatch(context.notifications.join("\n"), /Foreground wait/u);
});

test("cancelling a running implementer keeps its partial edits on the issue branch", async () => {
  const context = harness({
    startBranch: "feature/wip",
    pendingWorkerType: "implementer",
  });
  await context.engine.start();
  await waitForLaunch(context, "implementer");

  context.engine.stop();
  await context.engine.settle();

  assert.deepEqual(context.record()?.outcome, { kind: "cancelled" });
  assert.deepEqual(context.closedTerminals, ["terminal-1"]);
  assert.equal(context.gitCalls.includes("checkout feature/wip"), false);
  assert.equal((await context.git.status()).entries.length, 1);
});

test("cancelling a running automated reviewer uses the same owned-terminal path", async () => {
  const context = harness({
    startBranch: "feature/wip",
    settings: { review: true },
    pendingWorkerType: "reviewer",
  });
  await context.engine.start();
  await waitForLaunch(context, "reviewer");

  context.engine.stop();
  await context.engine.settle();

  assert.deepEqual(context.record()?.outcome, { kind: "cancelled" });
  assert.deepEqual(context.closedTerminals, ["terminal-1", "terminal-2"]);
  assert.equal(context.gitCalls.includes("checkout feature/wip"), false);
});

test("the implementer's account of its change is posted on the issue it addressed", async () => {
  const context = harness({
    implementerMessage: "Rewrote the backoff. Covered retry exhaustion.",
  });
  await context.engine.start();
  await context.engine.settle();

  // The account is posted verbatim: no completion markup is expected or stripped.
  assert.deepEqual(context.comments, [{
    issue: 34,
    body: "Rewrote the backoff. Covered retry exhaustion.",
  }]);
  assert.deepEqual(context.commitCalls, [], "aboard writes no commit message of its own");
  assert.match(context.createdPullRequests[0]?.body ?? "", /Rewrote the backoff\./u);
});

test("a comment that cannot be posted does not fail an issue that was addressed", async () => {
  const context = harness({ commentFails: true });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.comments, []);
  assert.equal([...context.pullRequests.values()][0]?.state, "merged");
  assert.match(context.notifications.join("\n"), new RegExp(`issue #34 merged into ${SESSION}`));
});

test("a conflicting pull request is reconciled with its base and then merged", async () => {
  const context = harness({ conflicting: true, reconcilable: true });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.gitCalls.includes(`mergeFromRemote ${SESSION}`), true);
  // Pushed without `-u`: the branch already tracks by the time it is merged.
  assert.equal(context.gitCalls.filter((call) => call === "push issue/34-add-retry-backoff").length, 1);
  assert.match(context.notifications.join("\n"), new RegExp(`conflicted with ${SESSION}; merged ${SESSION} into its branch and pushed`));
  assert.equal(context.pullRequests.get(56)?.state, "merged");
  // The run's own pull request is the only thing left for the user.
  assert.deepEqual(context.alerts.map((alert) => alert.message.includes("is yours to merge")), [true]);
});

test("an unresolvable conflict stops the whole run rather than skipping the issue", async () => {
  const context = harness({
    conflicting: true,
    reconcilable: false,
    issues: [
      { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 35, title: "Trim the cache", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), new RegExp(`PR #56 conflicts with ${SESSION}`));
  // The plan is ordered by dependency, so #35 is exactly the work that might
  // build on the change that did not land. Nothing behind the conflict runs.
  assert.deepEqual(context.launches.map((launch) => launch.issues), [[34]]);
  assert.equal([...context.pullRequests.values()].every((pr) => pr.state === "open"), true);
  // The record survives so the user can resume once they have resolved it.
  assert.equal(context.state.cleared, false);
  assert.deepEqual(context.record()?.outcome, { kind: "failed", reason: `PR #56 conflicts with ${SESSION} and the conflict is not one aboard can resolve` });
});

test("a merge refused for a reason other than a conflict still stops the whole run", async () => {
  const context = harness({
    mergeRefused: true,
    issues: [
      { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 35, title: "Trim the cache", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  // Branch protection applies to every pull request this run would open, so it
  // is not something to retry an issue at a time.
  assert.deepEqual(context.launches.map((launch) => launch.issues), [[34]]);
  assert.match(context.alerts[0]?.message ?? "", /Resolve the repository integration policy/);
  assert.equal(context.state.cleared, false);
});

test("a review that finds nothing records an empty completion commit", async () => {
  const context = harness({ settings: { review: true }, reviewerProducesChanges: false });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
  assert.match(context.notifications.join("\n"), /issue #34 reviewed; review committed/);
  assert.equal(context.gitCalls.filter((call) => call.startsWith("push issue/34")).length, 2);
  assert.equal(context.pullRequests.get(56)?.state, "merged");
  const landed = [...context.saved].reverse().find((record) => record.progress["34"]?.state === "done")?.progress["34"];
  assert.ok(landed?.state === "done" && landed.result === "landed" && landed.reviewedSha && landed.implementationSha);
  assert.equal(context.launches[0]?.completionCommitStartingSha, landed.beforeSha);
  assert.equal(context.launches[1]?.completionCommitStartingSha, landed.implementationSha);
  assert.notEqual(landed.reviewedSha, landed.implementationSha);
});

test("a reviewer that produces no completion commit stops the run", async () => {
  const context = harness({ settings: { review: true }, reviewerCompletes: false });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /review-this finished without committing/);
  assert.equal(context.pullRequests.get(56)?.state, "open");
  assert.equal(context.state.cleared, false);
});

test("a worker that makes more than one commit stops the run", async () => {
  const context = harness({ workerCommitCount: 2 });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /stopped at issue #34 .*created 2 commits; exactly one is allowed/);
  assert.equal(context.pullRequests.size, 0);
  assert.equal(context.record()?.currentIssue, 34, "the commits and the branch are left for inspection");
});

test("review mode launches an AFK reviewer and commits its fixes as a second commit", async () => {
  const context = harness({ settings: { review: true } });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
  // Both workers commit for themselves; aboard creates no commit of its own.
  assert.equal(context.gitCalls.filter((call) => call === "commit").length, 0);
  assert.match(context.notifications.join("\n"), /issue #34 reviewed; review committed \([0-9a-z]{8}\)/);
  assert.deepEqual(context.closedTerminals, ["terminal-1", "terminal-2"]);
});

test("every agent sent at an issue is launched at that issue's difficulty", async () => {
  const context = harness({
    settings: { review: true },
    issues: [{ number: 34, title: "Add retry backoff", labels: ["[AI]-afk", "[AI]-basic-difficulty"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  await context.engine.settle();

  // The reviewer checks the same change the implementer made, so it is rated the
  // same. What each tier costs is the launch planner's business.
  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
  assert.deepEqual(context.launches.map((launch) => launch.difficulty), ["basic", "basic"]);
});

test("an unrated issue is delegated with no difficulty at all, rather than a guessed one", async () => {
  const context = harness({ settings: { review: true } });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.difficulty), [undefined, undefined]);
});

test("a failing implementer stops the run with no commit and no pull request", async () => {
  const context = harness({ implementerFails: true });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.gitCalls.includes("commit"), false);
  assert.equal(context.pullRequests.size, 0);
  assert.match(context.notifications.join("\n"), /stopped at issue #34 \(implementer failed: context-exhausted\)/);
});

test("an implementer that commits nothing stops for user judgment", async () => {
  const context = harness({
    producesChanges: false,
    issues: [
      { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
      { number: 37, title: "Later", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.gitCalls.includes("commit"), false);
  assert.equal(context.pullRequests.size, 0);
  assert.equal(context.launches.length, 1);
  assert.equal(context.gitCalls.includes("deleteBranch issue/34-add-retry-backoff"), false);
  assert.equal(context.comments.length, 0);
  assert.match(context.notifications.join("\n"), /stopped at issue #34 .*address-this finished without committing/);
  assert.equal(context.state.cleared, false);
});

test("residual uncommitted changes stop the run even though the worker also committed", async () => {
  const context = harness({ workerLeavesDirtyTree: true });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.pullRequests.size, 0);
  assert.deepEqual(context.comments, []);
  assert.match(context.notifications.join("\n"), /left 1 uncommitted path/);
  assert.equal(context.record()?.currentIssue, 34);

  // The checkout is the user's to inspect; a resume never hands a dirty tree to
  // another worker, so it stops on the same condition rather than relaunching.
  assert.equal((await context.engine.resume()).started, true);
  await context.engine.settle();
  assert.equal(context.launches.filter((launch) => launch.type === "implementer").length, 1);
  assert.match(context.notifications.join("\n"), /uncommitted path\(s\).*src\/a.ts/);
});

test("a failed run can continue its exact ended worker with one Continue message", async () => {
  const context = harness({
    settings: { exploreBeforeImplement: true },
    implementerFails: true,
    producesChanges: false,
  });
  await context.engine.start();
  await context.engine.settle();

  const reference = context.record()?.workerSession;
  assert.ok(reference);
  const session: AgentSession = {
    platform: "claude",
    identity: { agentId: reference.agentId, type: reference.type },
    sessionId: reference.sessionId,
    sessionBinding: "bound",
    terminal: { terminalId: "terminal-1" as TerminalId, name: "aboard: address issue 34" },
    lifecycle: {
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
      finishedAt: "2026-01-01T00:01:00.000Z" as IsoTimestamp,
      exitCode: 0,
      lastAssistantMessage: null,
    },
    resultDelivery: { mode: "tool-result" },
    telemetry: telemetry(),
    issueNumbers: [34],
    autoRunRestricted: true,
  };
  assert.equal(continuationSessionFor(context.record()!, [session]), session);

  assert.equal((await context.engine.resume({ continueSession: session })).started, true);
  await context.engine.settle();

  assert.equal(context.launches.filter((launch) => launch.type === "implementer").length, 1, "no fresh worker was launched");
  assert.equal(context.launches.filter((launch) => launch.type === "Explore").length, 1, "continuation reuses its original exploration context");
  assert.equal(context.continuations.length, 1);
  assert.equal(context.continuations[0]?.session, session);
  assert.ok(context.continuations[0]?.completionCommitStartingSha);
  // The continued worker's own commit is what the run then published.
  assert.equal(context.gitCalls.some((call) => call.startsWith("push issue/34-add-retry-backoff")), true);
});

test("a resumed HITL-without-review implementer retains its non-committing contract", async () => {
  const context = harness({
    implementerFails: true,
    producesChanges: false,
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  await context.engine.settle();
  const session = endedWorkerSession(context.record()!, 35, "terminal-1");

  assert.equal((await context.engine.resume({ continueSession: session })).started, true);
  await waitForCommit(context);
  assert.equal(context.continuations[0]?.completionCommitStartingSha, undefined);
  context.engine.stop();
  await context.engine.settle();
});

test("a resumed HITL-with-review implementer retains its one-checkpoint-commit contract", async () => {
  const context = harness({
    implementerFails: true,
    producesChanges: false,
    settings: { review: true },
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  await context.engine.settle();
  const session = endedWorkerSession(context.record()!, 35, "terminal-1");

  assert.equal((await context.engine.resume({ continueSession: session })).started, true);
  await waitForCommit(context);
  assert.ok(context.continuations[0]?.completionCommitStartingSha);
  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
  context.engine.stop();
  await context.engine.settle();
});

test("a resumed AFK reviewer retains its fix-or-empty completion commit contract", async () => {
  const context = harness({ settings: { review: true }, reviewerFails: true });
  await context.engine.start();
  await context.engine.settle();
  const session = endedWorkerSession(context.record()!, 34, "terminal-2");

  assert.equal((await context.engine.resume({ continueSession: session })).started, true);
  await context.engine.settle();
  assert.ok(context.continuations[0]?.completionCommitStartingSha);
  assert.equal(context.state.cleared, true, context.notifications.join("\n"));
});

test("a run with its own checkout works there, launches there, and never moves the user's HEAD", async () => {
  const context = harness({ worktree: true, producesChanges: true, settings: { exploreBeforeImplement: true } });
  assert.equal((await context.engine.start()).started, true);
  await context.engine.settle();

  // Every effect of the run; the branch, the worker's commit, the push; belongs
  // to the checkout it was given.
  for (const effect of ["checkout", "createBranch", "push", "headSha", "isAncestor"]) {
    assert.ok(context.workspaceGitCalls.includes(effect), `${effect} must happen in the run's own checkout`);
  }
  // The user's checkout is only ever asked questions: what branch they are on,
  // whether this is a repository at all. Nothing moves it.
  for (const effect of ["checkout", "createBranch", "add", "commit", "push", "fastForward", "mergeFromRemote"]) {
    assert.ok(!context.userGitCalls.includes(effect), `${effect} reached the user's own checkout`);
  }
  assert.ok(!context.notifications.some((message) => message.includes("back on")), "there is no branch to return to");

  // Both agents run in that directory, fenced out of the user's by deny rules
  // the definition's own tool list knows nothing about.
  assert.ok(context.launches.length > 0);
  for (const launch of context.launches) {
    assert.equal(launch.isolation?.cwd, context.isolatedRoot);
    assert.deepEqual(launch.isolation?.denyTools, ["Read(//C:/work/aboard/**)"]);
  }
  assert.deepEqual(context.released, ["drained"], "a drained run's checkout has nothing left in it for the user");
});

test("a run with its own checkout does not care what is in the user's working tree", async () => {
  const context = harness({ worktree: true, startDirty: true });
  const result = await context.engine.start();
  assert.equal(result.started, true, "the user's own uncommitted work is not this run's business");
  await context.engine.settle();
});

test("an interrupted run keeps its checkout, because that is where the user was sent", async () => {
  const context = harness({ worktree: true, producesChanges: true, mergeRefused: true });
  assert.equal((await context.engine.start()).started, true);
  await context.engine.settle();
  assert.deepEqual(context.released, ["interrupted"]);
});

test("a dirty working tree refuses the run and names the dirty paths", async () => {
  const context = harness({ startDirty: true });
  const result = await context.engine.start();
  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /working tree is not clean: src\/a\.ts/);
  assert.equal(context.launches.length, 0);
  assert.equal(context.saved.length, 0);
});

test("an aboard session branch cannot become another run's target", async () => {
  const context = harness({ startBranch: "run/old" });
  const result = await context.engine.start();

  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /cannot start from run\/old.*run-owned artifacts/);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("an aboard issue branch is refused as a target even in worktree mode", async () => {
  const context = harness({ startBranch: "issue/34-old-issue", worktree: true });
  const result = await context.engine.start();

  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /cannot start from issue\/34-old-issue/);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("a dry run forecasts the exact queue and branches without creating run state or side effects", async () => {
  const context = harness({
    startBranch: "feature/wip",
    startDirty: true,
    settings: { review: true, exploreBeforeImplement: true, mergeRunPullRequest: true, permanentPrompt: "  run browser tests  " },
    issues: [
      { number: 41, title: "Ship the UI", labels: ["[AI]-hitl", "[AI]-advanced-difficulty", "[AI]-chrome"], state: "open", openBlockedByNumbers: [], dependencyNumbers: [42], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 42, title: "Build the API", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
      { number: 43, title: "Needs classification", labels: [], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-03T00:00:00.000Z" },
    ],
  });

  const result = await context.engine.dryRun({ additionalGuideline: "  no unit tests needed  " });

  assert.equal(result.inspected, true);
  if (!result.inspected) return;
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ["the working tree is not clean: src/a.ts"]);
  assert.equal(result.sessionBranch, "run/<run-id>");
  assert.equal(result.sessionBase, "feature/wip");
  assert.equal(result.reviewMode, true);
  assert.equal(result.exploresBeforeImplement, true);
  assert.equal(result.permanentPrompt, "run browser tests");
  assert.equal(result.additionalGuideline, "no unit tests needed");
  assert.equal(result.mergesItsOwnPullRequest, true);
  assert.deepEqual(result.issues.map((issue) => [issue.number, issue.branch]), [
    [42, "issue/42-build-the-api"],
    [41, "issue/41-ship-the-ui"],
  ]);
  assert.equal(result.issues.find((issue) => issue.number === 41)?.chrome, true);
  assert.deepEqual(result.skipped, [{ number: 43, reason: "unclassified: neither [AI]-afk nor [AI]-hitl" }]);
  assert.deepEqual(context.githubCalls, ["checkAuthentication", "listImplementableIssues"]);
  assert.deepEqual(context.gitCalls, ["fetch"]);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.states, []);
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(context.launches, []);
  assert.deepEqual(context.createdPullRequests, []);
});

test("a previewed start freezes the exact visible plan after its final validation", async () => {
  const context = harness();
  const preview = await context.engine.dryRun({ additionalGuideline: "visible guidance" });
  assert.equal(preview.inspected, true);
  if (!preview.inspected) return;
  context.githubCalls.splice(0);

  const result = await context.engine.startPreviewed(preview);

  assert.equal(result.started, true);
  if (!result.started) return;
  assert.deepEqual(context.record()?.plan, preview.issues);
  assert.equal(context.record()?.settings.additionalGuideline, "visible guidance");
  assert.deepEqual(context.githubCalls, ["checkAuthentication", "listImplementableIssues"], "Start validates once and freezes the visible plan without a third discovery");
  await context.engine.settle();
});

test("a previewed start keeps the visible plan stale when GitHub state changed", async () => {
  const context = harness();
  const preview = await context.engine.dryRun();
  assert.equal(preview.inspected, true);
  if (!preview.inspected) return;
  context.relabel(34, ["[AI]-hitl"]);
  context.githubCalls.splice(0);

  const result = await context.engine.startPreviewed(preview);

  assert.equal(result.started, false);
  assert.equal("refreshPreview" in result, true);
  if (result.started || !("refreshPreview" in result)) return;
  assert.equal(result.refreshPreview, true);
  assert.match(result.reason, /GitHub issue state changed.*refresh the preview/);
  assert.deepEqual(context.githubCalls, ["checkAuthentication", "listImplementableIssues"]);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("a dry run in worktree mode treats the user's dirty checkout as read-only", async () => {
  const context = harness({ worktree: true, startDirty: true });
  const result = await context.engine.dryRun();

  assert.equal(result.inspected, true);
  if (!result.inspected) return;
  assert.equal(result.ready, true);
  assert.equal(result.isolatedWorkspace, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(context.userGitCalls.includes("status"), true);
  assert.equal(context.workspaceGitCalls.length, 0, "dry-run never prepares or reads a second checkout");
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("a dry run with nothing to run reports an empty queue, not a blocker", async () => {
  const context = harness({
    issues: [{ number: 40, title: "Fix the parser", labels: [], state: "open", openBlockedByNumbers: [] }],
  });
  const result = await context.engine.dryRun();

  assert.equal(result.inspected, true);
  if (!result.inspected) return;
  // An empty queue is ordinary, not a problem to fix: it must not surface as a
  // blocker even though it does mean the run cannot start.
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.emptyReason, "no open issue is labelled [AI]-afk or [AI]-hitl (1 discarded)");
});

test("a dry run reports an aboard target branch as a blocker", async () => {
  const context = harness({ startBranch: "run/old", worktree: true });
  const result = await context.engine.dryRun();

  assert.equal(result.inspected, true);
  if (!result.inspected) return;
  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /cannot start from run\/old/);
  assert.equal(result.sessionBase, "run/old");
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("a dry run reports the same run-owned branch conflict that Start would refuse", async () => {
  const context = harness();
  context.createBranch("issue/34-add-retry-backoff");

  const result = await context.engine.dryRun();

  assert.equal(result.inspected, true);
  if (!result.inspected) return;
  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /issue\/34-add-retry-backoff already exists/);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("a branch that already has a pull request refuses the run the same way", async () => {
  const context = harness({
    preExistingPullRequestBranches: ["issue/34-add-retry-backoff"],
  });

  const result = await context.engine.start();

  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /a pull request already uses issue\/34-add-retry-backoff/);
  assert.deepEqual(context.launches, []);
  assert.deepEqual(context.saved, []);
});

test("an unauthenticated GitHub CLI refuses the run before querying or persisting a plan", async () => {
  const context = harness({ githubAuthenticationFails: true });
  const result = await context.engine.start();
  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /GitHub CLI cannot authenticate.*gh auth login/);
  assert.deepEqual(context.githubCalls, ["checkAuthentication"]);
  assert.equal(context.launches.length, 0);
  assert.equal(context.saved.length, 0);
});

test("an unauthenticated GitHub CLI makes a recorded run broken rather than resumable", async () => {
  const context = harness({ githubAuthenticationFails: true, startDirty: true });
  context.seed(plannedRecord());
  const result = await context.engine.resume();

  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /GitHub CLI can no longer authenticate/);
  assert.equal(context.launches.length, 0);
});

test("a second start returns the active run instead of starting another", async () => {
  const context = harness({
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  const second = await context.engine.start();
  assert.equal(second.started, false);
  assert.match((second as { reason: string }).reason, /already active/);
  context.engine.stop();
  await context.engine.settle();
});

test("an active run takes precedence over a dirty working tree without repeating authentication preflight", async () => {
  const context = harness({
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  assert.equal((await context.engine.start()).started, true);
  context.setDirty();
  const authenticationChecks = context.githubCalls.filter((call) => call === "checkAuthentication").length;

  const second = await context.engine.start();

  assert.equal(second.started, false);
  assert.match((second as { reason: string }).reason, /already active/);
  assert.equal((second as { active?: unknown }).active, context.engine.state());
  assert.equal(context.githubCalls.filter((call) => call === "checkAuthentication").length, authenticationChecks);
  context.engine.stop();
  await context.engine.settle();
});

test("issues are processed serially and re-derived after every merge", async () => {
  const context = harness({
    issues: [
      { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
      { number: 37, title: "Later", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [] },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  const branchOrder = context.gitCalls.filter((call) => call.startsWith("createBranch issue/3"));
  assert.deepEqual(branchOrder, [`createBranch issue/34-add-retry-backoff ${SESSION}`, `createBranch issue/37-later ${SESSION}`]);
  assert.match(context.notifications.join("\n"), /plan drained \(2 issues addressed\)/);
});

test("the queue drains standalone and child issues while reporting an unclassified parent", async () => {
  const context = harness({
    issues: [
      { number: 12, title: "Offline sync plan", labels: ["planning"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 40, title: "Fix the parser", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
      { number: 121, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-03T00:00:00.000Z" },
    ],
  });
  const result = await context.engine.start();
  assert.equal(result.started, true);
  assert.deepEqual(result.started && result.issues.map((issue) => issue.number), [40, 121]);
  await context.engine.settle();

  assert.deepEqual(
    context.gitCalls.filter((call) => call.startsWith("createBranch issue/1") || call.startsWith("createBranch issue/4")),
    [`createBranch issue/40-fix-the-parser ${SESSION}`, `createBranch issue/121-add-retry-backoff ${SESSION}`],
  );
  assert.match(context.notifications.join("\n"), /plan drained \(2 issues addressed\)/);
  assert.match(context.notifications.join("\n"), /1 issue discarded \(not ready to run\)/);
  assert.equal(context.state.cleared, true);
});

test("an empty queue refuses the run and counts the discarded candidates", async () => {
  const unlabelled = harness({
    issues: [{ number: 40, title: "Fix the parser", labels: [], state: "open", openBlockedByNumbers: [] }],
  });
  const refused = await unlabelled.engine.start();
  assert.equal(refused.started, false);
  // The reason is a count, never a per-issue list: dozens of unclassified
  // issues would bury the one fact the user needs.
  assert.equal((refused as { reason: string }).reason, "no open issue is labelled [AI]-afk or [AI]-hitl (1 discarded)");
  assert.equal(unlabelled.launches.length, 0);
  assert.equal(unlabelled.saved.length, 0);

  // Nothing labelled at all is a different problem with a different fix, so it
  // must not read as "everything is unclassified".
  const empty = harness({ issues: [] });
  const nothing = await empty.engine.start();
  assert.equal(nothing.started, false);
  assert.equal((nothing as { reason: string }).reason, "no open issue is labelled [AI]-afk or [AI]-hitl");
});

test("progress expands when an older blocked issue becomes ready", async () => {
  const context = harness({
    issues: [
      { number: 33, title: "Blocked first", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [34], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 34, title: "Unblock it", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
      { number: 35, title: "Still queued", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-03T00:00:00.000Z" },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.filter((launch) => launch.type === "implementer").map((launch) => launch.issues?.[0]), [34, 33, 35]);
  assert.equal(context.states.some((state) => state.currentIssue === 33 && state.completedCount === 1 && state.totalCount === 3), true);
  assert.equal(context.states.some((state) => state.currentIssue === 35 && state.completedCount === 2 && state.totalCount === 3), true);
});

test("a dependency cycle is visible and drains in deterministic order", async () => {
  const context = harness({
    issues: [
      { number: 34, title: "Older", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], dependencyNumbers: [37], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 37, title: "Newer", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], dependencyNumbers: [34], createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(
    context.launches.filter((launch) => launch.type === "implementer").map((launch) => launch.issues?.[0]),
    [34, 37],
  );
  assert.equal(context.notifications.some((entry) => entry.includes("dependency cycle") && entry.includes("#34, #37")), true);
});

test("resume re-enters at the first unsatisfied checkpoint and keeps the run's frozen guidance", async () => {
  const context = harness();
  // The record has a plan and nothing built yet, so the run starts from the
  // session branch; and the guidance it froze reaches the fresh worker.
  context.seed(plannedRecord({ settings: { ...plannedRecord().settings, additionalGuideline: "keep fixtures small" } }));
  assert.equal((await context.engine.resume()).started, true);
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
  assert.equal(context.launches[0]?.additionalGuideline, "keep fixtures small");
  // Resuming is a second attempt on the same run, not a new run.
  assert.equal(context.saved[0]?.runId, "run_test");
  assert.equal(context.saved.some((record) => record.attempt === 2), true);
});

test("a plan entry is never rediscovered: an issue labelled mid-run belongs to the next one", async () => {
  const context = harness({
    issues: [
      { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-01T00:00:00.000Z" },
      // Unclassified at planning time, so it is not in the plan. Labelling it
      // afterwards must not sneak it into a run the user already agreed to.
      { number: 40, title: "Fix the parser", labels: [], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  await context.engine.start();
  context.relabel(40, ["[AI]-afk"]);
  await context.engine.settle();

  assert.deepEqual(
    context.launches.filter((launch) => launch.type === "implementer").map((launch) => launch.issues?.[0]),
    [34],
  );
  assert.deepEqual(context.record()?.plan.map((issue) => issue.number) ?? [34], [34]);
});

test("recovered checkout validation and discard stay inside the recorded checkout", async () => {
  const context = harness({ worktree: true });
  const settings = plannedRecord().settings;
  context.seed(plannedRecord({
    settings: {
      ...settings,
      worktree: { ...settings.worktree, enabled: true },
      workspaceRoot: context.isolatedRoot,
    },
    workspaceCreated: true,
    outcome: { kind: "interrupted" },
  }));

  const result = await context.engine.discard("local-cleanup");
  assert.equal(result.workspaceRemoved, true);
  assert.deepEqual(context.recordedWorkspaceRemovals, [context.isolatedRoot]);
  assert.ok(context.workspaceGitCalls.includes("status"), "cleanup observations use the run checkout");
  assert.equal(context.userGitCalls.includes("status"), false, "the user's checkout is not validated as run state");
});

test("a frozen-plan mismatch after a worker returns stops before the next side effect", async () => {
  const context = harness({ relabelAfterImplementer: true });
  assert.equal((await context.engine.start()).started, true);
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
  assert.equal(context.gitCalls.includes("add"), false, "validation runs again before staging the worker's edits");
  assert.equal(context.comments.length, 0, "best-effort publication also waits for post-worker validation");
  assert.equal(context.createdPullRequests.length, 0);
  const outcome = context.record()?.outcome;
  assert.equal(outcome?.kind, "failed");
  assert.match(outcome?.kind === "failed" ? outcome.reason : "", /now hitl rather than afk/);
});

test("a version-1 record is unsupported: it is neither resumed nor silently dropped", async () => {
  const context = harness();
  const legacy = parseAutoRunRecord({
    version: 1,
    runId: "run_legacy",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "branch",
    branch: "issue/34-add-retry-backoff",
    reviewMode: false,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(legacy);
  assert.equal(legacy.version, 1);
  context.seed(legacy as never);

  assert.equal((await context.engine.refresh())?.state, "broken");
  const result = await context.engine.resume();
  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /predates human-acceptance persistence version 4/);
  assert.equal(context.launches.length, 0);
});

test("a commit that failed to push resumes by pushing, not by reporting no changes", async () => {
  const context = harness({ pushFails: true });
  await context.engine.start();
  await context.engine.settle();
  assert.match(context.notifications.join("\n"), /stopped at issue #34 \(push rejected\)/);

  // The commit landed; only the push failed. A resume must retry the push rather
  // than read the now-clean tree as "the implementer produced no changes".
  const resumed = harness({ pushFails: false });
  assert.equal((await resumed.engine.start()).started, true);
  await resumed.engine.settle();
  assert.match(resumed.notifications.join("\n"), /issue #34 merged/);
});

test("a recorded pull request that no longer exists makes the run broken rather than guessed at", async () => {
  const context = harness();
  context.createBranch(SESSION);
  context.seed(plannedRecord({
    currentIssue: 34,
    checkpoint: "issue",
    branchShas: { [SESSION]: context.sha(SESSION) },
    progress: { "34": { state: "current", phase: "await-commit", prNumber: 999 } },
  }));

  const eligibility = await context.engine.refresh();
  assert.equal(eligibility?.state, "broken");
  assert.match((eligibility as { reason: string }).reason, /pull request #999 no longer exists/);
  assert.equal((await context.engine.resume()).started, false);
  assert.equal(context.launches.length, 0);
});

test("a resumed run uses the settings it froze, not the ones configured now", async () => {
  const context = harness({ settings: { review: false } });
  context.seed(plannedRecord({ settings: { ...plannedRecord().settings, review: true } }));
  await context.engine.resume();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
});

test("a review already recorded is not repeated after a restart", async () => {
  const context = harness({ settings: { review: true } });
  context.seed(plannedRecord({
    settings: { ...plannedRecord().settings, review: true },
    // The in-memory owner map is empty after a restart and a review that found
    // nothing leaves no commit, so the record is the only witness.
    reviewedIssues: [34],
  }));
  await context.engine.resume();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
});

async function waitForCommit(context: Harness): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (context.engine.state()?.phase === "await-commit") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(context.notifications.join("\n"));
}

test("recovery fast-forwards an already merged issue without merging or implementing again", async () => {
  let interrupted = false;
  const context = harness({ beforeFastForward: (branch) => {
    if (interrupted || branch !== SESSION || context.merges.length === 0) return;
    interrupted = true;
    throw new Error("extension stopped before fast-forward");
  } });
  await context.engine.start();
  await context.engine.settle();
  assert.equal(context.record()?.pendingAction?.kind, "merge-issue-pr");
  assert.notEqual(await context.git.branchSha(SESSION), await context.git.remoteBranchSha(SESSION));
  assert.equal((await context.engine.resume()).started, true);
  await context.engine.settle();
  assert.equal(context.state.cleared, true, context.notifications.join("\n"));
  assert.equal(context.launches.length, 1);
  assert.equal(context.merges.length, 1);
  assert.equal(await context.git.branchSha(SESSION), await context.git.remoteBranchSha(SESSION));
});

for (const branchMode of ["per-issue", "single-branch"] as const) {
  for (const reviewerProducesChanges of [false, true]) {
    test(`${branchMode}: HITL review runs on the uncommitted checkpoint before one human acceptance commit (fixes=${reviewerProducesChanges})`, async () => {
      const context = harness({ hitlUncommitted: true, reviewerProducesChanges,
        settings: { branchMode, review: true },
        issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
      });
      await context.engine.start();
      await waitForCommit(context);
      assert.equal(context.createdPullRequests.length, 0);
      assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
      assert.ok(context.launches[0]?.completionCommitStartingSha);
      assert.equal(context.launches[1]?.completionCommitStartingSha, undefined);
      assert.match(context.launches[1]?.reviewRange ?? "", /^[0-9a-z]{40}\.\.[0-9a-z]{40}$/u);
      assert.equal(context.gitCalls.some((call) => call.startsWith("push issue/35-") || call.startsWith(`push ${SESSION}`) && call !== `push ${SESSION} -u`), false, "the temporary checkpoint is not published");
      assert.deepEqual(context.commitCalls, []);
      await context.git.commit("User accepts reviewed work", "");
      await context.engine.settle();
      assert.equal(context.state.cleared, true, context.notifications.join("\n"));
      assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
      assert.equal(context.merges.length, branchMode === "per-issue" ? 1 : 0);
      assert.equal(context.createdPullRequests.at(-1)?.base, "main");
      assert.deepEqual(context.closures.map((entry) => entry.issue), [35]);
      assert.equal(context.commitCalls.length, 1, "Aboard never manufactures acceptance");
      assert.ok(context.closedTerminals.includes("terminal-1" as TerminalId), "settled HITL terminal is released after integration");
      const landed = [...context.saved].reverse().find((record) => record.progress["35"]?.state === "done")?.progress["35"];
      assert.ok(landed?.state === "done" && landed.result === "landed" && landed.beforeSha && landed.implementerCommitSha && landed.resetCompleted && landed.hitlReviewCompleted && landed.implementationSha);
      assert.notEqual(landed.beforeSha, landed.implementationSha);
      assert.notEqual(landed.implementerCommitSha, landed.implementationSha);
    });
  }

  test(`${branchMode}: resume observes a HITL commit made while the extension was closed`, async () => {
    const context = harness({ hitlUncommitted: true, settings: { branchMode },
      issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    });
    await context.engine.start();
    await waitForCommit(context);
    context.engine.interrupt();
    await context.engine.settle();
    assert.equal(context.record()?.progress["35"]?.state, "current");
    assert.equal((await context.engine.refresh())?.state, "resumable");
    await context.git.commit("Accepted while closed", "");
    assert.equal((await context.engine.resume()).started, true);
    await context.engine.settle();
    assert.equal(context.state.cleared, true, context.notifications.join("\n"));
    assert.equal(context.launches.length, 1, "resume must not repeat implementation");
  });

  test(`${branchMode}: failed HITL launch stops before handoff even with a commit`, async () => {
    const context = harness({ implementerFails: true, settings: { branchMode },
      issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    });
    await context.engine.start();
    await context.engine.settle();
    assert.equal(context.states.some((state) => state.waiting), false);
    assert.equal(context.record()?.outcome?.kind, "failed");
    assert.deepEqual(context.createdPullRequests, []);
    assert.deepEqual(context.merges, []);
  });

  test(`${branchMode}: GitHub approval cannot accept dirty HITL work`, async () => {
    const context = harness({ hitlUncommitted: true, hitlReviewDecision: "approved", settings: { branchMode },
      issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    });
    await context.engine.start();
    await waitForCommit(context);
    await context.engine.refresh();
    assert.equal(context.engine.state()?.waiting, true);
    assert.deepEqual(context.createdPullRequests, []);
    context.engine.stop();
    await context.engine.settle();
  });

  test(`${branchMode}: closing the HITL terminal before acceptance stops without publishing`, async () => {
    const context = harness({ hitlUncommitted: true, settings: { branchMode },
      issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    });
    await context.engine.start();
    await waitForCommit(context);
    context.engine.terminalClosed("terminal-1" as TerminalId);
    await context.engine.settle();
    assert.equal(context.record()?.outcome?.kind, "failed");
    assert.deepEqual(context.createdPullRequests, []);
    assert.deepEqual(context.commitCalls, []);
  });

  test(`${branchMode}: switching branches during HITL is a structural failure`, async () => {
    const context = harness({ hitlUncommitted: true, settings: { branchMode },
      issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    });
    await context.engine.start();
    await waitForCommit(context);
    await context.git.checkout("main");
    context.engine.repositoryChanged();
    await context.engine.settle();
    assert.equal((await context.engine.refresh())?.state, "broken");
    assert.deepEqual(context.merges, []);
  });

  for (const reviewerProducesChanges of [false, true]) {
    test(`${branchMode}: interrupted reviewer adopts its completion commit when its result was not recorded (fixes=${reviewerProducesChanges})`, async () => {
      let interrupted: AutoRunRecord | undefined;
      const context = harness({ reviewerProducesChanges, settings: { branchMode, review: true },
        interruptBeforeSave: (next) => {
          if (interrupted !== undefined || next.pendingAction?.kind !== "worker-turn" || next.pendingAction.role !== "reviewer" || next.pendingAction.outcome !== "succeeded") return false;
          interrupted = context.record();
          return true;
        },
      });
      await context.engine.start();
      await context.engine.settle();
      assert.ok(interrupted);
      context.seed(interrupted);
      assert.equal((await context.engine.resume()).started, true);
      await context.engine.settle();
      assert.equal(context.state.cleared, true, context.notifications.join("\n"));
      assert.equal(context.launches.filter((launch) => launch.type === "reviewer").length, 1);
    });
  }

  for (const boundary of ["implementation", "publish", "review", "comment-issue", "create-issue-pr", "merge-issue-pr", "cleanup-issue", "close-issue", "create-run-pr", "update-run-pr", "merge-run-pr"] as const) {
    if (branchMode === "single-branch" && ["create-issue-pr", "merge-issue-pr", "cleanup-issue"].includes(boundary)) continue;
    test(`${branchMode}: recovery adopts ${boundary} without repeating a worker or push`, async () => {
      let interrupted: AutoRunRecord | undefined;
      let enabled = true;
      const context = harness({ settings: { branchMode, review: true, mergeRunPullRequest: boundary === "merge-run-pr" },
        interruptBeforeSave: (next) => {
          const previous = context.record();
          const action = previous?.pendingAction;
          const matches = boundary === "publish" ? action?.kind === "push" && previous?.currentIssue !== undefined && next.pendingAction === undefined
            : boundary === "implementation" || boundary === "review" ? action?.kind === "worker-turn" && action.outcome === "succeeded" && action.role === (boundary === "review" ? "reviewer" : "implementer") && next.pendingAction === undefined
              : action?.kind === boundary && next.pendingAction === undefined;
          if (!enabled || !matches) return false;
          enabled = false;
          interrupted = previous;
          return true;
        },
      });
      await context.engine.start();
      await context.engine.settle();
      assert.ok(interrupted, `did not interrupt at ${boundary}`);
      const updatesBeforeResume = context.updatedPullRequests.length;
      context.seed(interrupted);
      assert.equal((await context.engine.resume()).started, true, context.notifications.join("\n"));
      await context.engine.settle();
      assert.equal(context.state.cleared, true, context.notifications.join("\n"));
      assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "reviewer"]);
      if (boundary === "update-run-pr") assert.equal(context.updatedPullRequests.length, updatesBeforeResume, "completed PR update must not be repeated");
    });
  }
}

test("a normally completed HITL reviewer blocker message still enters human acceptance waiting", async () => {
  const context = harness({
    hitlUncommitted: true,
    reviewerMessage: "Blocked: the product owner must decide the compatibility behavior.",
    settings: { review: true },
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });

  await context.engine.start();
  await waitForCommit(context);

  assert.equal(context.engine.state()?.waiting, true);
  assert.equal(context.record()?.progress["35"]?.state, "current");
  assert.deepEqual(context.createdPullRequests, []);
  assert.doesNotMatch(context.notifications.join("\n"), /Blocked: the product owner/u);
  context.engine.stop();
  await context.engine.settle();
});

test("a technical HITL reviewer failure preserves and resumes the exact non-committing reviewer contract", async () => {
  const context = harness({
    hitlUncommitted: true,
    reviewerFails: true,
    settings: { review: true },
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  await context.engine.settle();

  const reference = context.record()?.workerSession;
  assert.ok(reference?.type === "reviewer" && reference.continuable === true);
  assert.equal(context.record()?.outcome?.kind, "failed");
  assert.deepEqual(context.createdPullRequests, []);
  const session: AgentSession = {
    platform: "claude",
    identity: { agentId: reference.agentId, type: "reviewer" },
    sessionId: reference.sessionId,
    sessionBinding: "bound",
    terminal: { terminalId: "terminal-2" as TerminalId, name: "aboard: review issue 35 before acceptance" },
    lifecycle: {
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
      finishedAt: "2026-01-01T00:01:00.000Z" as IsoTimestamp,
      exitCode: 1,
      lastAssistantMessage: null,
    },
    resultDelivery: { mode: "tool-result" },
    telemetry: telemetry(),
    issueNumbers: [35],
    autoRunRestricted: true,
  };

  assert.equal((await context.engine.resume({ continueSession: session })).started, true);
  await waitForCommit(context);
  assert.equal(context.continuations.length, 1);
  assert.equal(context.continuations[0]?.session, session);
  assert.equal(context.continuations[0]?.completionCommitStartingSha, undefined);
  assert.match(context.continuations[0]?.reviewRange ?? "", /^[0-9a-z]{40}\.\.[0-9a-z]{40}$/u);
  assert.equal(context.launches.filter((launch) => launch.type === "reviewer").length, 1, "the failed reviewer was continued, not relaunched");
  context.engine.stop();
  await context.engine.settle();
});

test("a commit created by the initial HITL reviewer is rejected before publication", async () => {
  const context = harness({
    hitlUncommitted: true,
    hitlReviewerCommits: true,
    settings: { review: true },
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });

  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.record()?.outcome?.kind, "failed");
  assert.match(context.notifications.join("\n"), /HITL reviewer committed, changed branches, or rewrote history/u);
  assert.deepEqual(context.createdPullRequests, []);
});

test("a HITL implementation reset must leave the checkpoint diff unstaged", async () => {
  const context = harness({
    hitlUncommitted: true,
    resetLeavesStaged: true,
    settings: { review: true },
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });

  await context.engine.start();
  for (let attempt = 0; attempt < 100 && context.record()?.outcome === undefined && context.engine.state()?.waiting !== true; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (context.engine.isActive()) context.engine.stop();
  await context.engine.settle();

  assert.equal(context.record()?.outcome?.kind, "failed");
  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
  assert.deepEqual(context.createdPullRequests, []);
  assert.match(context.notifications.join("\n"), /mixed reset.*index/iu);
});

test("a dirty partial HITL commit stops recoverably and an amended single commit resumes publication", async () => {
  const context = harness({
    hitlUncommitted: true,
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  await waitForCommit(context);

  await context.git.commit("Partial acceptance", "");
  context.setDirty();
  context.engine.repositoryChanged();
  await context.engine.settle();
  assert.equal(context.record()?.outcome?.kind, "failed");
  assert.match(context.notifications.join("\n"), /amending the same commit/u);
  assert.deepEqual(context.createdPullRequests, []);

  context.amendAcceptance();
  assert.equal((await context.engine.resume()).started, true);
  await context.engine.settle();
  assert.equal(context.state.cleared, true, context.notifications.join("\n"));
  assert.equal(context.commitCalls.length, 1, "the recovery keeps exactly one descendant commit");
  assert.equal(context.createdPullRequests.length > 0, true);
});

for (const boundary of ["before-reset", "after-reset", "reviewer-launch", "after-review"] as const) {
  test(`HITL review recovery resumes ${boundary} without duplicating completed work`, async () => {
    let interrupted: AutoRunRecord | undefined;
    let enabled = true;
    const context = harness({
      hitlUncommitted: true,
      settings: { review: true },
      issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
      interruptBeforeSave: (next) => {
        if (!enabled) return false;
        const previous = context.record();
        const nextProgress = next.progress["35"];
        const matches = boundary === "before-reset"
          ? next.pendingAction?.kind === "reset-implementation"
          : boundary === "after-reset"
            ? previous?.pendingAction?.kind === "reset-implementation" && next.pendingAction === undefined
              && nextProgress?.state === "current" && nextProgress.resetCompleted === true
            : boundary === "reviewer-launch"
              ? next.pendingAction?.kind === "worker-turn" && next.pendingAction.role === "reviewer" && next.pendingAction.outcome === undefined
              : previous?.pendingAction?.kind === "worker-turn" && previous.pendingAction.role === "reviewer"
                && previous.pendingAction.outcome === "succeeded" && next.pendingAction === undefined
                && nextProgress?.state === "current" && nextProgress.hitlReviewCompleted === true;
        if (!matches) return false;
        enabled = false;
        interrupted = previous;
        return true;
      },
    });

    await context.engine.start();
    await context.engine.settle();
    assert.ok(interrupted, `did not interrupt ${boundary}`);
    context.seed(interrupted);
    assert.equal((await context.engine.resume()).started, true, context.notifications.join("\n"));
    await waitForCommit(context);
    assert.equal(context.launches.filter((launch) => launch.type === "implementer").length, 1);
    assert.equal(context.launches.filter((launch) => launch.type === "reviewer").length, 1);
    await context.git.commit("Accept recovered review", "");
    await context.engine.settle();
    assert.equal(context.state.cleared, true, context.notifications.join("\n"));
  });
}

test("HITL acceptance recorded before publication resumes by publishing only the accepted commit", async () => {
  let interrupted: AutoRunRecord | undefined;
  let enabled = true;
  const context = harness({
    hitlUncommitted: true,
    settings: { review: true },
    issues: [{ number: 35, title: "human gate", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    interruptBeforeSave: (next) => {
      if (!enabled || next.currentIssue !== 35 || next.pendingAction?.kind !== "push") return false;
      const progress = next.progress["35"];
      if (progress?.state !== "current" || progress.implementationSha === undefined) return false;
      enabled = false;
      interrupted = context.record();
      return true;
    },
  });

  await context.engine.start();
  await waitForCommit(context);
  await context.git.commit("Accept reviewed work", "");
  context.engine.repositoryChanged();
  await context.engine.settle();
  assert.ok(interrupted);
  assert.equal(context.gitCalls.some((call) => call.startsWith("push issue/35-")), false);
  context.seed(interrupted);
  assert.equal((await context.engine.resume()).started, true, context.notifications.join("\n"));
  await context.engine.settle();
  assert.equal(context.state.cleared, true, context.notifications.join("\n"));
  assert.equal(context.launches.filter((launch) => launch.type === "implementer").length, 1);
  assert.equal(context.launches.filter((launch) => launch.type === "reviewer").length, 1);
  assert.equal(context.commitCalls.length, 1);
});
