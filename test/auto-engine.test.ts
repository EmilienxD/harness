import assert from "node:assert/strict";
import test from "node:test";

import { AutoRunEngine, type AutoRunGitHub, type AutoRunLauncher, type AutoRunState } from "../src/auto/engine.js";
import type { AutoRunSettings } from "../src/domain/auto-run.js";
import type { AutoRunRecord } from "../src/domain/run-plan.js";
import type { AgentId, SessionId, TerminalId } from "../src/domain/contracts.js";
import type { LaunchOrigin } from "../src/domain/lease.js";
import { GitBoundaryError, type GitClient, type GitStatus } from "../src/git/client.js";
import type { RunWorkspaceOutcome, RunWorkspaceProvider } from "../src/auto/worktree.js";
import { observeRun } from "../src/auto/observation.js";
import { parseAutoRunRecord } from "../src/runtime/persistence.js";
import type { DelegationLaunchInput } from "../src/bridge/delegation.js";

const WORKTREE_OFF = { enabled: false, root: "", keep: false, setupTimeoutSeconds: 600 } as const;
const SETTINGS: AutoRunSettings = { review: false, recursiveIssueReferences: false, discardBehavior: "record-only", pauseAfterHitl: false, mergeStrategy: "squash", mergeRunPullRequest: false, pollSeconds: 1, worktree: WORKTREE_OFF };

/** `runIdFactory` is fixed at `run_test`, so every run's session branch is this. */
const SESSION = "aboard/run/test";

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
  /** Every merge the engine asked for, and whether it asked to delete the branch. */
  readonly merges: { readonly pr: number; readonly deleteBranch: boolean }[];
  readonly launches: DelegationLaunchInput[];
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
  readonly settings?: Partial<AutoRunSettings>;
  /** The open issue queue the repository reports, in any order. */
  readonly issues?: readonly QueueIssue[];
  /** Working-tree entries reported after an implementer runs. */
  readonly producesChanges?: boolean;
  readonly implementerFails?: boolean;
  /** Final message returned by the implementer. */
  readonly implementerMessage?: string;
  /** Called once a hitl pull request has been observed as open; returns its next state. */
  readonly resolveHitl?: "merged" | "closed";
  readonly startDirty?: boolean;
  readonly pushFails?: boolean;
  readonly githubAuthenticationFails?: boolean;
  /** Simulates a hitl pr-doctor applying fixes the user approved, mid-wait. */
  readonly dirtyDuringWait?: boolean;
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
  /** Runs with a checkout of its own instead of the user's working tree. */
  readonly worktree?: boolean;
  /** Changes a frozen classification after the worker returns, before commit. */
  readonly relabelAfterImplementer?: boolean;
  /** Leaves this automated worker pending until the run aborts it. */
  readonly pendingWorkerType?: "implementer" | "pr-doctor-afk";
  /** Adds controllable latency or failure to every remote-ref observation. */
  readonly fetch?: () => Promise<void>;
  /** Head branches GitHub reports as already having a pull request, before the run opens any. */
  readonly preExistingPullRequestBranches?: readonly string[];
  /** Review decision GitHub reports on the hitl pull request once it is waiting. */
  readonly hitlReviewDecision?: "approved" | "changes-requested" | "reviewed" | "unreviewed";
}

function harness(options: HarnessOptions = {}): Harness {
  const notifications: string[] = [];
  const alerts: { message: string; url: string | undefined }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const closures: { issue: number; body: string }[] = [];
  const merges: { pr: number; deleteBranch: boolean }[] = [];
  const launches: DelegationLaunchInput[] = [];
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
  const commits = new Set<number>();
  const pushed = new Set<string>();
  const worktrees: { path: string; branch: string | undefined }[] = [];
  let currentBranch = options.startBranch ?? "main";
  let dirty = options.startDirty === true;
  let nextPr = 56;
  let hitlPolls = 0;
  const shas = new Map<string, number>();
  const inheritedShas = new Map<string, string>();
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
        : shaFor(branch)
      : undefined,
    commitDetails: async (ref) => ({ sha: shaFor(ref), parents: ["parent0000000000000000000000000000000000"], subject: "subject", message: "subject", treeSha: "tree000000000000000000000000000000000000" }),
    stagedTreeSha: async () => "tree000000000000000000000000000000000000",
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
    fastForward: async (branch) => { gitCalls.push(`fastForward ${branch}`); },
    mergeFromRemote: async (base) => {
      gitCalls.push(`mergeFromRemote ${base}`);
      if (options.reconcilable !== true) return false;
      // A reconciled branch is one GitHub will merge; the fake resolves every
      // conflicting pull request the same way a real base merge would.
      for (const [number, pr] of pullRequests) pullRequests.set(number, { ...pr, mergeable: "mergeable" });
      return true;
    },
    add: async () => { gitCalls.push("add"); },
    commit: async (subject, body) => { gitCalls.push("commit"); commitCalls.push({ subject, body }); dirty = false; commits.add(issueForBranch(currentBranch)); pushed.delete(currentBranch); advance(currentBranch); return shaFor(currentBranch); },
    push: async (branch, setUpstream) => {
      gitCalls.push(`push ${branch}${setUpstream ? " -u" : ""}`);
      // The session branch's own push is infrastructure, not the issue's commit;
      // a `pushFails` test is about the latter.
      if (options.pushFails === true && branch !== SESSION) throw new Error("push rejected");
      pushed.add(branch);
      remoteBranches.add(branch);
    },
    hasCommitFor: async (issueNumber) => commits.has(issueNumber),
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
      const waiting = notifications.some((entry) => entry.includes("is hitl — PR"));
      if (pr?.state === "open" && waiting && isHitl(number)) {
        hitlPolls += 1;
        // The doctor applies what the user approved once, mid-wait and uncommitted.
        if (options.dirtyDuringWait === true && hitlPolls === 1) dirty = true;
        if (hitlPolls >= 2 && options.resolveHitl !== undefined) {
          const base = basesByPr.get(number);
          if (options.resolveHitl === "merged" && base !== undefined) advance(base);
          pullRequests.set(number, {
            ...pr,
            state: options.resolveHitl,
            ...(options.resolveHitl === "merged" && base !== undefined ? { mergeCommitSha: shaFor(base) } : {}),
          });
        }
      }
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
      if (base !== undefined) advance(base);
      pullRequests.set(number, { state: "merged", ...(base === undefined ? {} : { mergeCommitSha: shaFor(base) }) });
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
    return Number(/^aboard\/(\d+)-/.exec(branch)?.[1] ?? 0);
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
      // Both agent types leave their work in the working tree; the engine commits.
      if (options.producesChanges !== false) dirty = true;
      if (input.type === options.pendingWorkerType) {
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
      if (input.type === "implementer" && options.relabelAfterImplementer === true) {
        queue.find((entry) => entry.number === input.issues?.[0])?.labels.splice(0, Infinity, "[AI]-hitl");
      }
      const implementer = input.type === "implementer";
      const failed = implementer && options.implementerFails === true;
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
                : "Addressed the issue.",
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
  const wrappedGithub: AutoRunGitHub = {
    ...github,
    createPullRequest: async (input) => {
      const number = await github.createPullRequest(input);
      branchesByPr.set(number, input.head);
      basesByPr.set(number, input.base);
      createdPullRequests.push({ ...input });
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
  const isolatedRoot = "C:/checkouts/run_test/aboard";
  const workspaces: RunWorkspaceProvider = {
    isolates: () => true,
    prepare: async () => ({
      root: isolatedRoot,
      git: trace(git, workspaceGitCalls),
      denyTools: [`Read(//C:/work/aboard/**)`],
      isolated: true,
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
        if (record.version !== 2) throw new Error("the engine must only ever write version-2 records");
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
    userGitCalls,
    workspaceGitCalls,
    released,
    isolatedRoot,
    closedPullRequests,
    recordedWorkspaceRemovals,
    record: () => stored,
    seed: (record: AutoRunRecord) => { stored = record; },
    branchExists: (branch: string) => branches.has(branch),
    remoteBranchExists: (branch: string) => remoteBranches.has(branch),
    sha: (branch: string) => shaFor(branch),
    advance,
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

function plannedRecord(overrides: Partial<AutoRunRecord> = {}): AutoRunRecord {
  return {
    version: 2,
    runId: "run_test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempt: 1,
    settings: {
      review: false,
      recursiveIssueReferences: false,
      mergeStrategy: "squash",
      mergeRunPullRequest: false,
      pauseAfterHitl: false,
      pollSeconds: 1,
      worktree: WORKTREE_OFF,
    },
    plan: [{ number: 34, title: "Add retry backoff", branch: "aboard/34-add-retry-backoff", disposition: "afk", dependsOn: [] }],
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

test("a transient recovery fetch failure stays unavailable rather than becoming broken", async () => {
  const context = harness({
    fetch: async () => {
      throw new GitBoundaryError("command-failed", "git fetch failed", {
        stderr: "fatal: cannot lock ref 'refs/remotes/origin/aboard/run/test'",
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
  assert.equal(context.launches[0]?.expectsUncommittedTree, true);
  assert.equal(context.launches[0]?.recursiveIssueReferences, false);
  assert.equal(context.launches[0]?.description, "address issue 34");
  // The issue number and branch reach the prompt; the wording around them is free.
  assert.equal(context.launches[0]?.prompt?.includes("#34"), true);
  assert.equal(context.launches[0]?.prompt?.includes("aboard/34-add-retry-backoff"), true);
  assert.deepEqual(context.gitCalls.filter((call) => call !== "fetch"), [
    // The session branch carries the user's local branch, including commits not
    // published yet, and is published before any issue starts.
    `createBranch ${SESSION} main`, `push ${SESSION} -u`,
    `checkout ${SESSION}`, `fastForward ${SESSION}`, `createBranch aboard/34-add-retry-backoff ${SESSION}`,
    "add", "commit", "push aboard/34-add-retry-backoff -u",
    // After the merge, so the record carries the session branch tip the merge
    // produced rather than the one it had before.
    `checkout ${SESSION}`, `fastForward ${SESSION}`,
    `checkout ${SESSION}`,
    `deleteBranchAt aboard/34-add-retry-backoff ${context.sha("aboard/34-add-retry-backoff")}`,
    `deleteRemoteBranchAt aboard/34-add-retry-backoff ${context.sha("aboard/34-add-retry-backoff")}`,
    "checkout main",
  ]);
  assert.equal(context.pullRequests.get(56)?.state, "merged");
  assert.match(context.notifications.join("\n"), /issue #34 committed \([0-9a-z]+\) and opened PR #56/);
  assert.match(context.notifications.join("\n"), new RegExp(`issue #34 merged into ${SESSION}`));
  assert.deepEqual(context.closedTerminals, ["terminal-1"], "the successful implementer is closed as soon as its result is accepted");
  assert.equal(context.state.cleared, true);
});

test("resume creates a missing session branch from the unpublished local target", async () => {
  const context = harness({
    remoteBaseSha: "f".repeat(40),
    implementerMessage: "The dependency is unavailable.",
  });
  context.seed(plannedRecord({ checkpoint: "workspace-ready" }));

  assert.equal((await context.engine.resume()).started, true);
  await context.engine.settle();

  assert.ok(context.gitCalls.includes(`createBranch ${SESSION} main`), context.gitCalls.join(", "));
  assert.equal(context.record()?.branchShas[SESSION], context.sha("main"));
  assert.notEqual(context.record()?.branchShas[SESSION], "f".repeat(40));
});

test("auto-run freezes recursive issue context and passes it only as launch data", async () => {
  const context = harness({ settings: { recursiveIssueReferences: true } });
  const result = await context.engine.start();
  assert.equal(result.started, true);
  await context.engine.settle();

  assert.equal(context.saved.some((record) => record.settings.recursiveIssueReferences), true);
  assert.equal(context.launches[0]?.recursiveIssueReferences, true);
  assert.equal(context.launches[0]?.prompt?.includes("recursive"), false);
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
  // pull request to merge — the alert is about the issue that would not merge.
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

test("an externally closed hitl pull request creates no concluding side effect", async () => {
  const context = harness({
    issues: [
      { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
    ],
    resolveHitl: "closed",
  });
  await context.engine.start();
  await context.engine.settle();

  // Closing a known PR is a structural mismatch. Existing work stays put, but
  // the run must not infer a new concluding side effect from a changed plan.
  assert.match(context.notifications.join("\n"), /stopped at issue #35/);
  assert.deepEqual(context.createdPullRequests.map((pullRequest) => pullRequest.head), [
    "aboard/34-add-retry-backoff",
    "aboard/35-migrate-the-queue",
  ]);
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
  assert.equal(context.launches[1]?.type, "pr-doctor-afk");
  assert.equal(context.launches[1]?.chrome, undefined);
  assert.equal(context.saved.every((record) => record.plan[0]?.chrome === true), true);
});

test("one additional guideline is persisted and reaches every auto agent", async () => {
  const context = harness({ settings: { review: true } });
  await context.engine.start({ additionalGuideline: "  no unit tests needed  " });
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "pr-doctor-afk"]);
  assert.deepEqual(context.launches.map((launch) => launch.additionalGuideline), ["no unit tests needed", "no unit tests needed"]);
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
  assert.equal(cleanups.length, 1, "only the terminal restore touches the original branch — per-issue cleanup still uses the default");
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

  assert.equal(context.gitCalls[context.gitCalls.length - 1], "checkout feature/wip");
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
  assert.equal(context.gitCalls.at(-1), "checkout feature/wip");
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
  assert.match(context.notifications.join("\n"), /stayed on aboard\/34-add-retry-backoff.*uncommitted work remains/u);
});

test("cancelling a running automated reviewer uses the same owned-terminal path", async () => {
  const context = harness({
    startBranch: "feature/wip",
    settings: { review: true },
    pendingWorkerType: "pr-doctor-afk",
  });
  await context.engine.start();
  await waitForLaunch(context, "pr-doctor-afk");

  context.engine.stop();
  await context.engine.settle();

  assert.deepEqual(context.record()?.outcome, { kind: "cancelled" });
  assert.deepEqual(context.closedTerminals, ["terminal-1", "terminal-2"]);
  assert.equal(context.gitCalls.includes("checkout feature/wip"), false);
});

test("the implementer's account of its change is posted on the issue it addressed", async () => {
  const context = harness({
    implementerMessage: "Rewrote the backoff.\n\n<commit>Fix retry backoff</commit>\n\nCovered retry exhaustion.",
  });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.comments, [{
    issue: 34,
    body: "**Fix retry backoff**\n\nRewrote the backoff.\n\nCovered retry exhaustion.",
  }]);
  assert.equal(context.commitCalls[0]?.subject, "Fix retry backoff");
  assert.doesNotMatch(context.createdPullRequests[0]?.body ?? "", /<commit>/u);
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
  assert.equal(context.gitCalls.filter((call) => call === "push aboard/34-add-retry-backoff").length, 1);
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
  assert.match(context.alerts[0]?.message ?? "", /auto-run cannot approve its own pull request/);
  assert.equal(context.state.cleared, false);
});

test("review mode launches a pr-doctor-afk and commits its fixes as a second commit", async () => {
  const context = harness({ settings: { review: true } });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "pr-doctor-afk"]);
  // Two commits: the implementation, then the doctor's fixes.
  assert.equal(context.gitCalls.filter((call) => call === "commit").length, 2);
  assert.match(context.notifications.join("\n"), /issue #34 reviewed; committing 1 changed path\(s\)/);
  assert.deepEqual(context.closedTerminals, ["terminal-1", "terminal-2"]);
});

test("every agent sent at an issue is launched at that issue's difficulty", async () => {
  const context = harness({
    settings: { review: true },
    issues: [{ number: 34, title: "Add retry backoff", labels: ["[AI]-afk", "[AI]-basic-difficulty"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  await context.engine.settle();

  // The doctor reviews the same change the implementer made, so it is rated the
  // same. What each tier costs is the launch planner's business.
  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "pr-doctor-afk"]);
  assert.deepEqual(context.launches.map((launch) => launch.difficulty), ["basic", "basic"]);
});

test("an unrated issue is delegated with no difficulty at all, rather than a guessed one", async () => {
  const context = harness({ settings: { review: true } });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.difficulty), [undefined, undefined]);
});

test("a hitl issue waits at its pull request and continues once the user merges", async () => {
  const context = harness({
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    resolveHitl: "merged",
  });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /issue #35 is hitl — PR #56 is open and waiting for you/);
  assert.match(context.notifications.join("\n"), /PR #56 merged by you; continuing/);
  assert.equal(
    context.saved.some((record) => record.branchShas[SESSION] === context.sha(SESSION)),
    true,
    "the exact session tip produced by the user's merge is adopted before continuing",
  );
  assert.deepEqual(context.closedTerminals, ["terminal-1"], "the implementer closes but no interactive reviewer was launched");
  assert.equal(context.state.cleared, true);
});

test("a hitl reviewer stays open while the run awaits the user and closes after resolution", async () => {
  const context = harness({
    settings: { review: true },
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  for (let attempt = 0; attempt < 100 && context.engine.state()?.waiting !== true; attempt += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }

  assert.equal(context.engine.state()?.waiting, true);
  assert.equal(context.engine.owner(56)?.type, "pr-doctor-hitl");
  assert.deepEqual(context.closedTerminals, ["terminal-1"], "only the completed implementer closes while review is active");

  context.advance(SESSION);
  context.pullRequests.set(56, { state: "merged", mergeable: "mergeable", mergeCommitSha: context.sha(SESSION) });
  context.engine.continueNow();
  await context.engine.settle();

  assert.deepEqual(context.closedTerminals, ["terminal-1", "terminal-2"]);
});

test("a hitl pull request closed unmerged stops the run and leaves the branch alone", async () => {
  const context = harness({
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    resolveHitl: "closed",
  });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /stopped at issue #35 .*closed without merging/);
  const branchCreated = context.gitCalls.lastIndexOf(`createBranch aboard/35-migrate-the-queue ${SESSION}`);
  assert.notEqual(branchCreated, -1, "the issue branch was created");
  assert.deepEqual(
    context.gitCalls.slice(branchCreated + 1).filter((call) => call.startsWith("checkout ")),
    [],
    "no cleanup or original-branch checkout followed the failure",
  );
  assert.equal(context.state.cleared, false, "the record survives a stop so an explicit resume can re-enter");
});

test("a failing implementer stops the run with no commit and no pull request", async () => {
  const context = harness({ implementerFails: true });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.gitCalls.includes("commit"), false);
  assert.equal(context.pullRequests.size, 0);
  assert.match(context.notifications.join("\n"), /stopped at issue #34 \(implementer failed: context-exhausted\)/);
});

test("an implementer completion marker without changes stops for user judgment", async () => {
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
  assert.equal(context.gitCalls.includes("deleteBranch aboard/34-add-retry-backoff"), false);
  assert.equal(context.comments.length, 0);
  assert.match(context.notifications.join("\n"), /stopped at issue #34 .*confirmed issue #34 complete but produced no changes/);
  assert.equal(context.state.cleared, false);
});

test("partial work without a commit marker stops and a resume sends it to a fresh implementer", async () => {
  const context = harness({ implementerMessage: "Implemented half, but dependency installation is blocked." });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.gitCalls.includes("commit"), false);
  assert.equal(context.pullRequests.size, 0);
  assert.deepEqual(context.comments, []);
  assert.match(context.notifications.join("\n"), /did not confirm that the issue is complete/);
  assert.equal(context.record()?.currentIssue, 34);

  assert.equal((await context.engine.resume()).started, true);
  await context.engine.settle();
  assert.equal(context.launches.filter((launch) => launch.type === "implementer").length, 2);
  assert.equal(context.gitCalls.includes("commit"), false);
});

test("a run with its own checkout works there, launches there, and never moves the user's HEAD", async () => {
  const context = harness({ worktree: true, producesChanges: true });
  assert.equal((await context.engine.start()).started, true);
  await context.engine.settle();

  // Every effect of the run — the branch, the commit, the push — belongs to the
  // checkout it was given.
  for (const effect of ["checkout", "createBranch", "add", "commit", "push"]) {
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
  const context = harness({ startBranch: "aboard/run/old" });
  const result = await context.engine.start();

  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /cannot start from aboard\/run\/old.*run-owned artifacts/);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("an aboard issue branch is refused as a target even in worktree mode", async () => {
  const context = harness({ startBranch: "aboard/34-old-issue", worktree: true });
  const result = await context.engine.start();

  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /cannot start from aboard\/34-old-issue/);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("a dry run forecasts the exact queue and branches without creating run state or side effects", async () => {
  const context = harness({
    startBranch: "feature/wip",
    startDirty: true,
    settings: { review: true, pauseAfterHitl: true, mergeRunPullRequest: true },
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
  assert.equal(result.sessionBranch, "aboard/run/<run-id>");
  assert.equal(result.sessionBase, "feature/wip");
  assert.equal(result.reviewMode, true);
  assert.equal(result.pauseAfterHitl, true);
  assert.equal(result.additionalGuideline, "no unit tests needed");
  assert.equal(result.mergesItsOwnPullRequest, true);
  assert.deepEqual(result.issues.map((issue) => [issue.number, issue.branch]), [
    [42, "aboard/42-build-the-api"],
    [41, "aboard/41-ship-the-ui"],
  ]);
  assert.equal(result.issues.find((issue) => issue.number === 41)?.chrome, true);
  assert.deepEqual(result.skipped, [{ number: 43, reason: "unclassified: neither [AI]-afk nor [AI]-hitl" }]);
  assert.deepEqual(context.githubCalls, ["checkAuthentication", "listImplementableIssues"]);
  assert.deepEqual(context.gitCalls, []);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.states, []);
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(context.launches, []);
  assert.deepEqual(context.createdPullRequests, []);
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
  const context = harness({ startBranch: "aboard/run/old", worktree: true });
  const result = await context.engine.dryRun();

  assert.equal(result.inspected, true);
  if (!result.inspected) return;
  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /cannot start from aboard\/run\/old/);
  assert.equal(result.sessionBase, "aboard/run/old");
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("a dry run reports the same run-owned branch conflict that Start would refuse", async () => {
  const context = harness();
  context.createBranch("aboard/34-add-retry-backoff");

  const result = await context.engine.dryRun();

  assert.equal(result.inspected, true);
  if (!result.inspected) return;
  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /aboard\/34-add-retry-backoff already exists/);
  assert.deepEqual(context.saved, []);
  assert.deepEqual(context.launches, []);
});

test("a branch that already has a pull request refuses the run the same way", async () => {
  const context = harness({
    preExistingPullRequestBranches: ["aboard/34-add-retry-backoff"],
  });

  const result = await context.engine.start();

  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /a pull request already uses aboard\/34-add-retry-backoff/);
  assert.deepEqual(context.launches, []);
  assert.deepEqual(context.saved, []);
});

test("a hitl pull request approved by another account is adopted without waiting for a merge", async () => {
  const context = harness({
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    resolveHitl: "merged",
    hitlReviewDecision: "approved",
  });
  await context.engine.start();
  await context.engine.settle();

  // The approval rides in the pull-request snapshot, so the run does not wait
  // for the user to merge by hand before continuing.
  assert.match(context.notifications.join("\n"), /issue #35 merged/);
  assert.equal(context.state.cleared, true);
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

  const branchOrder = context.gitCalls.filter((call) => call.startsWith("createBranch aboard/3"));
  assert.deepEqual(branchOrder, [`createBranch aboard/34-add-retry-backoff ${SESSION}`, `createBranch aboard/37-later ${SESSION}`]);
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
    context.gitCalls.filter((call) => call.startsWith("createBranch aboard/1") || call.startsWith("createBranch aboard/4")),
    [`createBranch aboard/40-fix-the-parser ${SESSION}`, `createBranch aboard/121-add-retry-backoff ${SESSION}`],
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
  // session branch — and the guidance it froze reaches the fresh worker.
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
    branch: "aboard/34-add-retry-backoff",
    reviewMode: false,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(legacy);
  assert.equal(legacy.version, 1);
  context.seed(legacy as never);

  assert.equal((await context.engine.refresh())?.state, "broken");
  const result = await context.engine.resume();
  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /predates fixed-plan recovery/);
  assert.equal(context.launches.length, 0);
});

test("a hitl doctor's approved fixes are committed to the pull request before it merges", async () => {
  // Without this the user merges a pull request that does not contain the
  // changes they just approved, and the work is stranded uncommitted.
  const context = harness({
    settings: { review: true },
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    resolveHitl: "merged",
    dirtyDuringWait: true,
  });
  await context.engine.start({ additionalGuideline: "keep migration reversible" });
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "pr-doctor-hitl"]);
  assert.deepEqual(context.launches.map((launch) => launch.additionalGuideline), ["keep migration reversible", "keep migration reversible"]);
  // Handed to the user but still leased: the run is committing behind it, which
  // is exactly the collision the lease exists to prevent.
  assert.deepEqual(context.interactiveOrigins, ["auto-run"]);
  // The implementation commit, then the fixes captured while the PR was open.
  assert.equal(context.gitCalls.filter((call) => call === "commit").length, 2);
  assert.match(context.notifications.join("\n"), /committed 1 changed path\(s\) from issue #35's open terminals to PR #56/);
  // The capture must land before the merge is observed, or it missed the boat.
  const log = context.notifications.join("\n");
  assert.ok(log.indexOf("open terminals") < log.indexOf("merged by you"), "fixes were committed before the merge was observed");
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
    progress: { "34": { state: "current", phase: "await-approval", prNumber: 999 } },
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

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "pr-doctor-afk"]);
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
