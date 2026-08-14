import assert from "node:assert/strict";
import test from "node:test";

import { AutoRunEngine, type AutoRunGitHub, type AutoRunLauncher } from "../src/auto/engine.js";
import type { AutoRunRecord, AutoRunSettings } from "../src/domain/auto-run.js";
import type { AgentId, SessionId, TerminalId } from "../src/domain/contracts.js";
import type { LaunchOrigin } from "../src/domain/lease.js";
import type { GitClient, GitStatus } from "../src/git/client.js";
import type { DelegationLaunchInput } from "../src/bridge/delegation.js";

const SETTINGS: AutoRunSettings = { review: false, scope: "spec", pauseAfterHitl: false, mergeStrategy: "squash", pollSeconds: 1 };

interface Harness {
  readonly engine: AutoRunEngine;
  readonly notifications: string[];
  readonly launches: DelegationLaunchInput[];
  /** Origins the engine declared for its handed-off launches; they decide the lease. */
  readonly interactiveOrigins: LaunchOrigin[];
  readonly gitCalls: string[];
  readonly githubCalls: string[];
  readonly saved: AutoRunRecord[];
  readonly state: { cleared: boolean };
  readonly pullRequests: Map<number, { state: "open" | "closed" | "merged" }>;
}

interface HarnessOptions {
  readonly settings?: Partial<AutoRunSettings>;
  readonly subIssues?: readonly { number: number; title: string; labels: string[]; state: "open" | "closed"; openBlockedByNumbers: number[] }[];
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
  /** More than one open spec, for the scope setting. Issue n belongs to spec n % 10. */
  readonly specs?: readonly { number: number; title: string; createdAt: string }[];
}

/** With multiple specs, an issue's parent is encoded in its number: 121 → spec 12. */
function parentOf(issueNumber: number): number {
  return Math.floor(issueNumber / 10);
}

function harness(options: HarnessOptions = {}): Harness {
  const notifications: string[] = [];
  const launches: DelegationLaunchInput[] = [];
  const interactiveOrigins: LaunchOrigin[] = [];
  const gitCalls: string[] = [];
  const githubCalls: string[] = [];
  const saved: AutoRunRecord[] = [];
  const state = { cleared: false };
  const pullRequests = new Map<number, { state: "open" | "closed" | "merged" }>();
  const branches = new Set<string>(["main"]);
  const commits = new Set<number>();
  const pushed = new Set<string>();
  let currentBranch = "main";
  let dirty = options.startDirty === true;
  let nextPr = 56;
  let hitlPolls = 0;

  const subIssues = options.subIssues ?? [
    { number: 34, title: "Add retry backoff", labels: ["afk"], state: "open" as const, openBlockedByNumbers: [] },
  ];
  const open = new Set(subIssues.filter((entry) => entry.state === "open").map((entry) => entry.number));

  const git: GitClient = {
    currentBranch: async () => currentBranch,
    defaultBranch: async () => "main",
    status: async (): Promise<GitStatus> => ({ branch: currentBranch, entries: dirty ? [{ status: "M", path: "src/a.ts" }] : [] }),
    headSha: async () => "a1b2c3d",
    branchExists: async (branch) => branches.has(branch),
    fetch: async () => { gitCalls.push("fetch"); },
    checkout: async (branch) => { gitCalls.push(`checkout ${branch}`); currentBranch = branch; },
    createBranch: async (branch, from) => { gitCalls.push(`createBranch ${branch} ${from}`); branches.add(branch); currentBranch = branch; },
    fastForward: async () => { gitCalls.push("fastForward"); },
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
    listSpecIssues: async () => {
      githubCalls.push("listSpecIssues");
      return options.specs ?? [{ number: 12, title: "Offline sync", createdAt: "2026-01-01T00:00:00.000Z" }];
    },
    listSubIssues: async (parent) => subIssues.filter((entry) => open.has(entry.number) && (options.specs === undefined || parentOf(entry.number) === parent)),
    getIssue: async (number) => ({ state: open.has(number) ? "open" : "closed" }),
    createPullRequest: async () => { const number = nextPr++; pullRequests.set(number, { state: "open" }); return number; },
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
        if (hitlPolls >= 2 && options.resolveHitl !== undefined) pullRequests.set(number, { state: options.resolveHitl });
      }
      return pr;
    },
    getReviewState: async () => ({ decision: "unreviewed" }),
    mergePullRequest: async (number) => {
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
    return subIssues.find((entry) => entry.number === issueForPr(number))?.labels.includes("hitl") === true;
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
    notifier: { notify: (message) => notifications.push(message) },
    settings: () => ({ ...SETTINGS, ...options.settings }),
    runIdFactory: () => "run_test",
    // A macrotask, not an immediately-resolved promise: a microtask-only poll
    // would starve the event loop and never observe an abort.
    sleep: () => new Promise((resolve) => { setImmediate(resolve); }),
  });

  return { engine, notifications, launches, interactiveOrigins, gitCalls, githubCalls, saved, state, pullRequests };
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
    subIssues: [{ number: 35, title: "Migrate the queue", labels: ["hitl"], state: "open", openBlockedByNumbers: [] }],
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
    subIssues: [{ number: 35, title: "Migrate the queue", labels: ["hitl"], state: "open", openBlockedByNumbers: [] }],
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
    specNumber: 12,
    issueNumbers: [34],
    currentIssue: 34,
    phase: "commit",
    branch: "aboard/34-add-retry-backoff",
    prNumber: undefined,
    reviewMode: false,
    scope: "spec",
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
    subIssues: [{ number: 35, title: "Migrate the queue", labels: ["hitl"], state: "open", openBlockedByNumbers: [] }],
  });
  await context.engine.start();
  const second = await context.engine.start();
  assert.equal(second.started, false);
  assert.match((second as { reason: string }).reason, /already active/);
  context.engine.stop();
  await context.engine.settle();
});

test("issues are processed serially and re-derived after every merge", async () => {
  const context = harness({
    subIssues: [
      { number: 34, title: "Add retry backoff", labels: ["afk"], state: "open", openBlockedByNumbers: [] },
      { number: 37, title: "Later", labels: ["afk"], state: "open", openBlockedByNumbers: [] },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  const branchOrder = context.gitCalls.filter((call) => call.startsWith("createBranch"));
  assert.deepEqual(branchOrder, ["createBranch aboard/34-add-retry-backoff main", "createBranch aboard/37-later main"]);
  assert.match(context.notifications.join("\n"), /spec #12 complete \(2 issues\)/);
});

test("scope spec stops after one spec and reports what remains", async () => {
  const context = harness({
    specs: [
      { number: 12, title: "Offline sync", createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 13, title: "Search", createdAt: "2026-02-01T00:00:00.000Z" },
    ],
    subIssues: [
      { number: 121, title: "Add retry backoff", labels: ["afk"], state: "open", openBlockedByNumbers: [] },
      { number: 131, title: "Index the corpus", labels: ["afk"], state: "open", openBlockedByNumbers: [] },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  assert.match(context.notifications.join("\n"), /spec #12 complete \(1 issue\)\. 1 open spec remains — run \/auto to continue/);
  assert.equal(context.notifications.join("\n").includes("issue #131"), false, "the next spec is not touched");
});

test("scope all continues into the next open spec", async () => {
  const context = harness({
    settings: { scope: "all" },
    specs: [
      { number: 12, title: "Offline sync", createdAt: "2026-01-01T00:00:00.000Z" },
      { number: 13, title: "Search", createdAt: "2026-02-01T00:00:00.000Z" },
    ],
    subIssues: [
      { number: 121, title: "Add retry backoff", labels: ["afk"], state: "open", openBlockedByNumbers: [] },
      { number: 131, title: "Index the corpus", labels: ["afk"], state: "open", openBlockedByNumbers: [] },
    ],
  });
  await context.engine.start();
  await context.engine.settle();

  const log = context.notifications.join("\n");
  assert.match(log, /continuing into spec #13 "Search"/);
  assert.match(log, /issue #131 merged/);
  assert.match(log, /spec #13 complete \(1 issue\)\. 0 open specs remain/);
  assert.equal(context.state.cleared, true);
});

test("resume re-derives from the repository rather than trusting the record", async () => {
  const context = harness();
  // The record claims the run reached `merge`, but nothing exists in the
  // repository yet, so the engine re-enters at `branch`.
  const record: AutoRunRecord = {
    version: 1,
    runId: "run_old",
    specNumber: 12,
    issueNumbers: [34],
    currentIssue: 34,
    phase: "merge",
    branch: "aboard/34-add-retry-backoff",
    prNumber: 56,
    reviewMode: false,
    scope: "spec",
    reviewedIssues: [],
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal((await context.engine.resume(record)).started, true);
  await context.engine.settle();
  assert.equal(context.gitCalls[0], "fetch");
  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
});

test("a hitl doctor's approved fixes are committed to the pull request before it merges", async () => {
  // Without this the user merges a pull request that does not contain the
  // changes they just approved, and the work is stranded uncommitted.
  const context = harness({
    settings: { review: true },
    subIssues: [{ number: 35, title: "Migrate the queue", labels: ["hitl"], state: "open", openBlockedByNumbers: [] }],
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
    specNumber: 12,
    issueNumbers: [34],
    currentIssue: 34,
    phase: "await-approval",
    branch: "aboard/34-add-retry-backoff",
    prNumber: 999,
    reviewMode: false,
    scope: "spec",
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
    specNumber: 12,
    issueNumbers: [34],
    currentIssue: 34,
    phase: "branch",
    branch: "aboard/34-add-retry-backoff",
    prNumber: undefined,
    reviewMode: true,
    scope: "spec",
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
    specNumber: 12,
    issueNumbers: [34],
    currentIssue: 34,
    phase: "review",
    branch: "aboard/34-add-retry-backoff",
    prNumber: undefined,
    reviewMode: true,
    scope: "spec",
    // The in-memory owner map is empty after a restart and a review that found
    // nothing leaves no commit, so the record is the only witness.
    reviewedIssues: [34],
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  await context.engine.resume(record);
  await context.engine.settle();

  assert.deepEqual(context.launches.map((launch) => launch.type), ["implementer"]);
});
