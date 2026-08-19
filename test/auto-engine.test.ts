import assert from "node:assert/strict";
import test from "node:test";

import { AutoRunEngine, type AutoRunGitHub, type AutoRunLauncher, type AutoRunState } from "../src/auto/engine.js";
import type { AutoRunRecord, AutoRunSettings } from "../src/domain/auto-run.js";
import type { AgentId, SessionId, TerminalId } from "../src/domain/contracts.js";
import type { LaunchOrigin } from "../src/domain/lease.js";
import type { GitClient, GitStatus } from "../src/git/client.js";
import { parseAutoRunRecord } from "../src/runtime/persistence.js";
import type { DelegationLaunchInput } from "../src/bridge/delegation.js";

const SETTINGS: AutoRunSettings = { review: false, pauseAfterHitl: false, mergeStrategy: "squash", pollSeconds: 1 };

interface FakePullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly mergeable?: "mergeable" | "conflicting" | "unknown";
}

interface Harness {
  readonly engine: AutoRunEngine;
  readonly notifications: string[];
  /** Messages the engine escalated because they need the user's hands. */
  readonly alerts: { readonly message: string; readonly url: string | undefined }[];
  readonly comments: { readonly issue: number; readonly body: string }[];
  readonly launches: DelegationLaunchInput[];
  /** Origins the engine declared for its handed-off launches; they decide the lease. */
  readonly interactiveOrigins: LaunchOrigin[];
  readonly gitCalls: string[];
  readonly githubCalls: string[];
  readonly saved: AutoRunRecord[];
  readonly states: AutoRunState[];
  readonly state: { cleared: boolean };
  readonly pullRequests: Map<number, FakePullRequest>;
  readonly setDirty: () => void;
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
  readonly hasChildren?: boolean;
}

interface HarnessOptions {
  readonly settings?: Partial<AutoRunSettings>;
  /** The open issue queue the repository reports, in any order. */
  readonly issues?: readonly QueueIssue[];
  /** Working-tree entries reported after an implementer runs. */
  readonly producesChanges?: boolean;
  readonly implementerFails?: boolean;
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
}

function harness(options: HarnessOptions = {}): Harness {
  const notifications: string[] = [];
  const alerts: { message: string; url: string | undefined }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const launches: DelegationLaunchInput[] = [];
  const interactiveOrigins: LaunchOrigin[] = [];
  const gitCalls: string[] = [];
  const githubCalls: string[] = [];
  const saved: AutoRunRecord[] = [];
  const states: AutoRunState[] = [];
  const state = { cleared: false };
  const pullRequests = new Map<number, FakePullRequest>();
  const branches = new Set<string>(["main", "feature/wip"]);
  const commits = new Set<number>();
  const pushed = new Set<string>();
  let currentBranch = options.startBranch ?? "main";
  let dirty = options.startDirty === true;
  let nextPr = 56;
  let hitlPolls = 0;

  const queue = options.issues ?? [
    { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open" as const, openBlockedByNumbers: [] },
  ];
  const open = new Set(queue.filter((entry) => entry.state === "open").map((entry) => entry.number));

  const git: GitClient = {
    currentBranch: async () => currentBranch,
    defaultBranch: async () => "main",
    status: async (): Promise<GitStatus> => ({ branch: currentBranch, entries: dirty ? [{ status: "M", path: "src/a.ts" }] : [] }),
    codebase: async () => ({ sourceFileCount: 12, languages: ["ts"], commitCount: 40 }),
    headSha: async () => "a1b2c3d",
    branchExists: async (branch) => branches.has(branch),
    fetch: async () => { gitCalls.push("fetch"); },
    checkout: async (branch) => { gitCalls.push(`checkout ${branch}`); currentBranch = branch; },
    createBranch: async (branch, from) => { gitCalls.push(`createBranch ${branch} ${from}`); branches.add(branch); currentBranch = branch; },
    fastForward: async () => { gitCalls.push("fastForward"); },
    mergeFromRemote: async (base) => {
      gitCalls.push(`mergeFromRemote ${base}`);
      if (options.reconcilable !== true) return false;
      // A reconciled branch is one GitHub will merge; the fake resolves every
      // conflicting pull request the same way a real base merge would.
      for (const [number, pr] of pullRequests) pullRequests.set(number, { ...pr, mergeable: "mergeable" });
      return true;
    },
    add: async () => { gitCalls.push("add"); },
    commit: async () => { gitCalls.push("commit"); dirty = false; commits.add(issueForBranch(currentBranch)); pushed.delete(currentBranch); return "a1b2c3d"; },
    push: async (branch, setUpstream) => {
      gitCalls.push(`push ${branch}${setUpstream ? " -u" : ""}`);
      if (options.pushFails === true) throw new Error("push rejected");
      pushed.add(branch);
    },
    hasCommitFor: async (issueNumber) => commits.has(issueNumber),
    isPushed: async (branch) => pushed.has(branch),
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
        hasChildren: entry.hasChildren === true,
      }));
      return { candidates };
    },
    getIssue: async (number) => ({ state: open.has(number) ? "open" : "closed" }),
    addIssueComment: async (number, body) => {
      if (options.commentFails === true) throw new Error("gh issue comment failed");
      comments.push({ issue: number, body });
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
    getPullRequest: async (number) => {
      const pr = pullRequests.get(number);
      // Only reads issued from inside the wait count. `#observe` reads the same
      // pull request every iteration, so counting those would resolve it before
      // the run ever reaches the gate — and with review on, before the doctor
      // has been launched at all.
      const waiting = notifications.some((entry) => entry.includes("is hitl — PR"));
      if (pr?.state === "open" && waiting && isHitl(number)) {
        hitlPolls += 1;
        // The doctor applies what the user approved once, mid-wait and uncommitted.
        if (options.dirtyDuringWait === true && hitlPolls === 1) dirty = true;
        if (hitlPolls >= 2 && options.resolveHitl !== undefined) pullRequests.set(number, { ...pr, state: options.resolveHitl });
      }
      return pr === undefined ? undefined : { ...pr, mergeable: pr.mergeable ?? "mergeable", url: `https://github.com/acme/app/pull/${number}` };
    },
    getReviewState: async () => ({ decision: "unreviewed" }),
    mergePullRequest: async (number) => {
      const pr = pullRequests.get(number);
      if (options.mergeRefused === true) throw new Error("Protected branch rules not met");
      if (pr?.mergeable === "conflicting") throw new Error("Pull request is not mergeable");
      pullRequests.set(number, { state: "merged" });
      open.delete(issueForPr(number));
    },
  };

  const branchesByPr = new Map<number, string>();
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
    runAutomated: async (input) => {
      launches.push(input);
      // Both agent types leave their work in the working tree; the engine commits.
      if (options.producesChanges !== false) dirty = true;
      const failed = input.type === "implementer" && options.implementerFails === true;
      return {
        agentId: `agent-${launches.length}` as AgentId,
        sessionId: "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId,
        terminalId: `terminal-${launches.length}` as TerminalId,
        result: failed
          ? { outcome: "failed", failure: { type: "context-exhausted", exitCode: 1, lastAssistantMessage: null }, telemetry: telemetry() }
          : { outcome: "succeeded", exitCode: 0, lastAssistantMessage: "Implemented the change.", telemetry: telemetry() },
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
  const wrappedGithub: AutoRunGitHub = {
    ...github,
    createPullRequest: async (input) => {
      const number = await github.createPullRequest(input);
      branchesByPr.set(number, input.head);
      return number;
    },
  };

  const engine = new AutoRunEngine({
    git,
    github: wrappedGithub,
    launcher,
    terminals: { close: () => undefined },
    store: {
      load: async () => undefined,
      save: async (record) => { saved.push(record); },
      clear: async () => { state.cleared = true; },
    },
    notifier: {
      notify: (message) => notifications.push(message),
      alert: (message, url) => { notifications.push(message); alerts.push({ message, url }); },
    },
    settings: () => ({ ...SETTINGS, ...options.settings }),
    runIdFactory: () => "run_test",
    // A macrotask, not an immediately-resolved promise: a microtask-only poll
    // would starve the event loop and never observe an abort.
    sleep: () => new Promise((resolve) => { setImmediate(resolve); }),
    onStateChange: (next) => { if (next !== undefined) states.push(next); },
  });

  return {
    engine,
    notifications,
    alerts,
    comments,
    launches,
    interactiveOrigins,
    gitCalls,
    githubCalls,
    saved,
    states,
    state,
    pullRequests,
    setDirty: () => { dirty = true; },
  };
}

function telemetry() {
  return { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 };
}

test("the afk path runs branch to merge and performs every side effect itself", async () => {
  const context = harness();
  const result = await context.engine.start();
  assert.equal(result.started, true);
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
  assert.equal(context.launches[0]?.expectsUncommittedTree, true);
  assert.deepEqual(context.gitCalls, [
    "fetch", "checkout main", "fastForward", "createBranch aboard/34-add-retry-backoff main",
    "add", "commit", "push aboard/34-add-retry-backoff -u",
    "checkout main",
  ]);
  assert.equal([...context.pullRequests.values()][0]?.state, "merged");
  assert.match(context.notifications.join("\n"), /issue #34 committed \(a1b2c3d\) and opened PR #56/);
  assert.match(context.notifications.join("\n"), /issue #34 merged, issue closed/);
  assert.equal(context.state.cleared, true);
});

test("one Chrome choice is persisted for the run and reaches implementers only", async () => {
  const context = harness({ settings: { review: true } });
  const result = await context.engine.start({ chrome: true });
  assert.equal(result.started && result.chromeEnabled, true);
  await context.engine.settle();

  assert.equal(context.launches[0]?.type, "implementer");
  assert.equal(context.launches[0]?.chrome, true);
  assert.equal(context.launches[1]?.type, "pr-doctor-afk");
  assert.equal(context.launches[1]?.chrome, undefined);
  assert.equal(context.saved.every((record) => record.chromeEnabled === true), true);
  assert.match(context.notifications[0] ?? "", /Chrome on/);
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

test("a stop restores the original branch when the tree is clean", async () => {
  // A failed implementer stops the run; with producesChanges off the launch
  // left nothing behind, so the restore is safe and must run.
  const context = harness({ startBranch: "feature/wip", implementerFails: true, producesChanges: false });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /implementer failed/);
  assert.equal(context.gitCalls[context.gitCalls.length - 1], "checkout feature/wip");
});

test("a stop with uncommitted work does not check out over it", async () => {
  // The failed implementer still dirtied the tree before the engine noticed the
  // failure, so the run stops on the issue branch holding uncommitted work —
  // exactly when a checkout would strand it. The restore must stay home.
  const context = harness({ startBranch: "feature/wip", implementerFails: true });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /implementer failed/);
  assert.equal(context.gitCalls.includes("checkout feature/wip"), false);
});

test("the implementer's account of its change is posted on the issue it implemented", async () => {
  const context = harness();
  await context.engine.start();
  await context.engine.settle();

  // Verbatim and on the issue, not only in the pull request body a squash merge
  // eventually folds away.
  assert.deepEqual(context.comments, [{ issue: 34, body: "Implemented the change." }]);
});

test("a comment that cannot be posted does not fail an issue that was implemented", async () => {
  const context = harness({ commentFails: true });
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.comments, []);
  assert.equal([...context.pullRequests.values()][0]?.state, "merged");
  assert.match(context.notifications.join("\n"), /issue #34 merged, issue closed/);
});

test("a conflicting pull request is reconciled with its base and then merged", async () => {
  const context = harness({ conflicting: true, reconcilable: true });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.gitCalls.includes("mergeFromRemote main"), true);
  // Pushed without `-u`: the branch already tracks by the time it is merged.
  assert.equal(context.gitCalls.filter((call) => call === "push aboard/34-add-retry-backoff").length, 1);
  assert.match(context.notifications.join("\n"), /conflicted with main; merged main into its branch and pushed/);
  assert.equal([...context.pullRequests.values()][0]?.state, "merged");
  assert.deepEqual(context.alerts, []);
});

test("an unresolvable conflict parks its issue, alerts the user, and lets the run continue", async () => {
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

  assert.match(context.notifications.join("\n"), /issue #34 parked — PR #56 needs you \(it conflicts with main/);
  // The alert carries the pull request so the warning can offer to open it.
  assert.deepEqual(context.alerts.map((alert) => alert.url), [
    "https://github.com/acme/app/pull/56",
    "https://github.com/acme/app/pull/57",
  ]);
  // A conflict is a fact about one branch, so the queue behind it still runs.
  assert.deepEqual(context.launches.map((launch) => launch.issues), [[34], [35]]);
  assert.equal([...context.pullRequests.values()].every((pr) => pr.state === "open"), true);
  assert.match(context.notifications.join("\n"), /queue drained \(0 issues implemented, 2 parked for you\)/);
  assert.equal(context.state.cleared, true);
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
  assert.equal(context.state.cleared, true);
});

test("a hitl pull request closed unmerged stops the run and leaves the branch alone", async () => {
  const context = harness({
    issues: [{ number: 35, title: "Migrate the queue", labels: ["[AI]-hitl"], state: "open", openBlockedByNumbers: [] }],
    resolveHitl: "closed",
  });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /stopped at issue #35 .*closed without merging/);
  assert.equal(context.gitCalls.includes("checkout main"), true, "the branch phase still ran, but no cleanup checkout followed the stop");
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

test("an implementer that produced no changes is a failure, not an empty commit", async () => {
  const context = harness({ producesChanges: false });
  await context.engine.start();
  await context.engine.settle();

  assert.equal(context.gitCalls.includes("commit"), false);
  assert.match(context.notifications.join("\n"), /produced no changes/);
});

test("a dirty working tree refuses the run and names the dirty paths", async () => {
  const context = harness({ startDirty: true });
  const result = await context.engine.start();
  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /working tree is not clean: src\/a\.ts/);
  assert.equal(context.launches.length, 0);
  assert.equal(context.saved.length, 0);
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

test("an unauthenticated GitHub CLI refuses resume without rejecting a dirty recovery tree", async () => {
  const context = harness({ githubAuthenticationFails: true, startDirty: true });
  const result = await context.engine.resume({
    version: 1,
    runId: "run_interrupted",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "commit",
    branch: "aboard/34-add-retry-backoff",
    prNumber: undefined,
    reviewMode: false,
    reviewedIssues: [],
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(result.started, false);
  assert.match((result as { reason: string }).reason, /GitHub CLI cannot authenticate/);
  assert.deepEqual(context.githubCalls, ["checkAuthentication"]);
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

  const branchOrder = context.gitCalls.filter((call) => call.startsWith("createBranch"));
  assert.deepEqual(branchOrder, ["createBranch aboard/34-add-retry-backoff main", "createBranch aboard/37-later main"]);
  assert.match(context.notifications.join("\n"), /queue drained \(2 issues implemented\)/);
});

test("the queue drains a parentless issue and a spec child alike, in creation order", async () => {
  const context = harness({
    issues: [
      // The spec itself is an umbrella and never enters the queue, even though
      // it is open and older than everything else.
      { number: 12, title: "Offline sync", labels: ["[AI]-spec"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-01T00:00:00.000Z", hasChildren: true },
      { number: 40, title: "Fix the parser", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
      { number: 121, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-03T00:00:00.000Z" },
    ],
  });
  const result = await context.engine.start();
  assert.equal(result.started, true);
  assert.deepEqual(result.started && result.issues.map((issue) => issue.number), [40, 121]);
  await context.engine.settle();

  assert.deepEqual(
    context.gitCalls.filter((call) => call.startsWith("createBranch")),
    ["createBranch aboard/40-fix-the-parser main", "createBranch aboard/121-add-retry-backoff main"],
  );
  assert.match(context.notifications.join("\n"), /queue drained \(2 issues implemented\)/);
  assert.equal(/#12\b/u.test(context.notifications.join("\n")), false, "the spec is not queued and not reported");
  assert.equal(context.state.cleared, true);
});

test("an empty queue refuses the run and names why each candidate was skipped", async () => {
  const unlabelled = harness({
    issues: [{ number: 40, title: "Fix the parser", labels: [], state: "open", openBlockedByNumbers: [] }],
  });
  const refused = await unlabelled.engine.start();
  assert.equal(refused.started, false);
  assert.match((refused as { reason: string }).reason, /#40 \(unclassified: neither \[AI\]-afk nor \[AI\]-hitl\)/);
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

test("resume re-derives from the repository rather than trusting the record", async () => {
  const context = harness();
  // The record claims the run reached `merge`, but nothing exists in the
  // repository yet, so the engine re-enters at `branch`.
  const record: AutoRunRecord = {
    version: 1,
    runId: "run_old",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "merge",
    branch: "aboard/34-add-retry-backoff",
    prNumber: 56,
    reviewMode: false,
    reviewedIssues: [],
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal((await context.engine.resume(record)).started, true);
  await context.engine.settle();
  assert.equal(context.gitCalls[0], "fetch");
  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
});

test("a record an older version wrote against one spec resumes onto the flat queue", async () => {
  const context = harness({
    issues: [
      { number: 34, title: "Add retry backoff", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-01T00:00:00.000Z" },
      // Unreachable under the old model — no parent spec — and processed now.
      { number: 40, title: "Fix the parser", labels: ["[AI]-afk"], state: "open", openBlockedByNumbers: [], createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  const legacy = parseAutoRunRecord({
    version: 1,
    runId: "run_legacy",
    specNumber: 12,
    scope: "spec",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "branch",
    branch: "aboard/34-add-retry-backoff",
    reviewMode: false,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(legacy);
  assert.equal((await context.engine.resume(legacy)).started, true);
  await context.engine.settle();

  assert.deepEqual(
    context.gitCalls.filter((call) => call.startsWith("createBranch")),
    ["createBranch aboard/34-add-retry-backoff main", "createBranch aboard/40-fix-the-parser main"],
  );
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
  await context.engine.start();
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "pr-doctor-hitl"]);
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

test("a persisted pull request that no longer exists does not skip the pr phase", async () => {
  const context = harness();
  const record: AutoRunRecord = {
    version: 1,
    runId: "run_old",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "await-approval",
    branch: "aboard/34-add-retry-backoff",
    prNumber: 999,
    reviewMode: false,
    reviewedIssues: [],
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  await context.engine.resume(record);
  await context.engine.settle();

  // #999 resolves to nothing, so it is not a pull request: the run opens a real
  // one instead of trying to merge a number it read out of a stale record.
  assert.equal(context.pullRequests.has(999), false);
  assert.equal([...context.pullRequests.values()][0]?.state, "merged");
  assert.match(context.notifications.join("\n"), /opened PR #56/);
});

test("a resumed run keeps the review mode it started with, not the current setting", async () => {
  const context = harness({ settings: { review: false } });
  const record: AutoRunRecord = {
    version: 1,
    runId: "run_old",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "branch",
    branch: "aboard/34-add-retry-backoff",
    prNumber: undefined,
    reviewMode: true,
    reviewedIssues: [],
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  await context.engine.resume(record);
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer", "pr-doctor-afk"]);
});

test("a review already recorded is not repeated after a restart", async () => {
  const context = harness({ settings: { review: true } });
  const record: AutoRunRecord = {
    version: 1,
    runId: "run_old",
    issueNumbers: [34],
    currentIssue: 34,
    phase: "review",
    branch: "aboard/34-add-retry-backoff",
    prNumber: undefined,
    reviewMode: true,
    // The in-memory owner map is empty after a restart and a review that found
    // nothing leaves no commit, so the record is the only witness.
    reviewedIssues: [34],
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  await context.engine.resume(record);
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
});
