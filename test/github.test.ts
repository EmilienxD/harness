import assert from "node:assert/strict";
import test from "node:test";

import { GitHubBoundaryError, GitHubClient, type GhExecutor } from "../src/github/client.js";

class FixtureGh implements GhExecutor {
  private readonly mutableCalls: string[][] = [];
  public get calls(): readonly string[][] { return this.mutableCalls; }
  public constructor(private readonly respond: (args: readonly string[]) => string) {}
  public async run(args: readonly string[]): Promise<string> {
    this.mutableCalls.push([...args]);
    return this.respond(args);
  }
}

const repo = JSON.stringify({ owner: { login: "EmilienxD" }, name: "aboard" });
const graph = (value: unknown) => JSON.stringify({ data: { repository: value } });

test("authentication preflight is fresh, targets the workspace repository, and primes GraphQL identity", async () => {
  let failing = true;
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") {
      assert.deepEqual(args, ["repo", "view", "--json", "owner,name"]);
      if (failing) throw new GitHubBoundaryError("command-failed", "GitHub CLI command failed");
      return repo;
    }
    return graph({ issues: { nodes: [] } });
  });
  const github = new GitHubClient(gh);

  await assert.rejects(
    () => github.checkAuthentication(),
    (error: unknown) => error instanceof GitHubBoundaryError && error.code === "command-failed",
  );
  failing = false;
  await github.checkAuthentication();
  assert.deepEqual(await github.listSpecIssues(), []);

  assert.equal(gh.calls.filter((args) => args[0] === "repo").length, 2);
  assert.equal(gh.calls.filter((args) => args[0] === "api").length, 1);
});

test("looks up, persists, and caches the singleton TODO number, then updates by argument", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return '[{"number":12}]';
    if (args[0] === "repo") return repo;
    if (args[0] === "api" && args[1] === "graphql") return graph({ issue: { number: 12, title: "TODO", body: "Now", state: "OPEN", labels: { nodes: [{ name: "ai:todo" }] }, parent: null, closedByPullRequestsReferences: { nodes: [] } } });
    if (args[0] === "issue" && args[1] === "edit") return "";
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  assert.deepEqual(await github.getTodo(), { number: 12, body: "Now" });
  assert.deepEqual(await github.updateTodo("Next"), { number: 12, body: "Next" });
  // The in-session cache kept updateTodo from rescanning the label.
  assert.equal(gh.calls.filter((args) => args[0] === "issue" && args[1] === "list").length, 1);
  assert.deepEqual(gh.calls.at(-1), ["issue", "edit", "12", "--body", "Next"]);
});

test("creates the TODO on first write and reports a missing read", async () => {
  const createGh = new FixtureGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "label") return "";
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/EmilienxD/aboard/issues/44\n";
    throw new Error("unexpected");
  });
  assert.deepEqual(await new GitHubClient(createGh).updateTodo("First roadmap"), { number: 44, body: "First roadmap" });
  assert.equal(createGh.calls.some((args) => args.includes("--force")), true);

  await assert.rejects(() => new GitHubClient(new FixtureGh(() => "[]")).getTodo(), (error: unknown) => error instanceof GitHubBoundaryError && error.code === "missing-todo");
});

test("ambiguity never fails: reads adopt the newest carrier, writes mint a fresh issue and strip the rest", async () => {
  const readGh = new FixtureGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return '[{"number":50},{"number":3}]';
    if (args[0] === "repo") return repo;
    if (args[0] === "api" && args[1] === "graphql") return graph({ issue: { number: 50, title: "TODO", body: "Fifty", state: "OPEN", labels: { nodes: [{ name: "ai:todo" }] }, parent: null, closedByPullRequestsReferences: { nodes: [] } } });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  assert.deepEqual(await new GitHubClient(readGh).getTodo(), { number: 50, body: "Fifty" });
  // Reads stay read-only: the surviving labels are the write path's problem.
  assert.equal(readGh.calls.some((args) => args.includes("--remove-label")), false);

  const writeGh = new FixtureGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return '[{"number":50},{"number":3}]';
    if (args[0] === "label") return "";
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/EmilienxD/aboard/issues/44\n";
    if (args[0] === "issue" && args[1] === "edit") return "";
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  assert.deepEqual(await new GitHubClient(writeGh).updateTodo("Fresh"), { number: 44, body: "Fresh" });
  assert.equal(writeGh.calls.some((args) => args.join(" ") === "issue edit 50 --remove-label ai:todo"), true);
  assert.equal(writeGh.calls.some((args) => args.join(" ") === "issue edit 3 --remove-label ai:todo"), true);
});

test("with no cached number, reads report missing and writes create fresh", async () => {
  const deleted = (args: readonly string[]) => {
    if (args[0] === "repo") return repo;
    if (args[0] === "api" && args[1] === "graphql") return graph({ issue: null });
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "label") return "";
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/EmilienxD/aboard/issues/44\n";
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  await assert.rejects(() => new GitHubClient(new FixtureGh(deleted)).getTodo(), (error: unknown) => error instanceof GitHubBoundaryError && error.code === "missing-todo");

  const writeGh = new FixtureGh(deleted);
  assert.deepEqual(await new GitHubClient(writeGh).updateTodo("New roadmap"), { number: 44, body: "New roadmap" });
  assert.equal(writeGh.calls.some((args) => args[0] === "issue" && args[1] === "edit"), false);
});

test("derives readiness solely from dependency closedness and flags classification", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    return graph({ issues: { nodes: [
      { number: 16, title: "ready hitl", labels: { nodes: [{ name: "ai:hitl" }] }, blockedBy: { nodes: [{ number: 15, state: "CLOSED" }] } },
      { number: 17, title: "blocked afk", labels: { nodes: [{ name: "ai:afk" }] }, blockedBy: { nodes: [{ number: 16, state: "OPEN" }] } },
      { number: 18, title: "unclassified", labels: { nodes: [] }, blockedBy: { nodes: [] } },
      { number: 19, title: "umbrella", labels: { nodes: [{ name: "ai:spec" }] }, blockedBy: { nodes: [] } },
    ] } });
  });
  const issues = await new GitHubClient(gh).listRoadmapIssues();
  assert.deepEqual(issues.map((issue) => [issue.number, issue.ready, issue.disposition]), [
    [16, true, "hitl"], [17, false, "afk"], [18, true, "unclassified"],
  ]);
});

test("resolves issue parent, PR state, threads, diff, and publishes line comments", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    if (args[0] === "pr" && args[1] === "diff") return "diff --git a/a.ts b/a.ts";
    if (args[0] === "api" && args[1]?.startsWith("repos/")) return "{}";
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("reviewThreads(first:100){nodes{id")) return graph({ pullRequest: { reviewThreads: { nodes: [{ id: "T1", isResolved: false, path: "src/a.ts", line: 7, comments: { nodes: [{ body: "Bug", author: { login: "emb" } }] } }] } } });
    if (query.includes("issue(number")) return graph({ issue: { number: 17, title: "Review", body: "Contract", state: "OPEN", labels: { nodes: [{ name: "ai:hitl" }] }, parent: { number: 9 }, closedByPullRequestsReferences: { nodes: [{ headRefName: "feat/17" }] } } });
    return graph({ pullRequest: { number: 42, title: "PR", body: "Body", state: "OPEN", merged: false, headRefName: "feat/17", baseRefName: "main", headRefOid: "abc123", closingIssuesReferences: { nodes: [{ number: 17 }] }, reviewDecision: null, reviewThreads: { nodes: [{ isResolved: false }] } } });
  });
  const github = new GitHubClient(gh);
  assert.equal((await github.getIssue(17))?.parentIssueNumber, 9);
  assert.equal((await github.getPullRequest(42))?.issueNumber, 17);
  assert.equal(await github.getPullRequestDiff(42), "diff --git a/a.ts b/a.ts");
  assert.equal((await github.listReviewThreads(42))[0]?.comments[0]?.author, "emb");
  assert.deepEqual(await github.getReviewState(42), { decision: "unreviewed", unresolvedThreadCount: 1 });
  await github.publishReviewFinding(42, { body: "Null crash", path: "src/a.ts", line: 7 });
  assert.equal(gh.calls.some((args) => args.includes("path=src/a.ts") && args.includes("line=7")), true);
});

test("malformed gh JSON is a typed boundary failure", async () => {
  await assert.rejects(() => new GitHubClient(new FixtureGh(() => "not-json")).getTodo(), (error: unknown) => error instanceof GitHubBoundaryError && error.code === "malformed-output");
});

test("briefing data surfaces only merges with no durable review", async () => {
  const gh = new FixtureGh(() => JSON.stringify([
    { number: 40, title: "Reviewed", mergedAt: "2026-07-30T08:00:00Z", reviews: [{ state: "APPROVED" }] },
    { number: 41, title: "Unreviewed", mergedAt: "2026-07-30T09:00:00Z", reviews: [] },
  ]));
  assert.deepEqual(await new GitHubClient(gh).listUnreviewedMerges("2026-07-30T00:00:00Z"), [
    { number: 41, title: "Unreviewed", mergedAt: "2026-07-30T09:00:00Z" },
  ]);
  assert.equal(gh.calls[0]?.includes("merged:>=2026-07-30T00:00:00Z"), true);
});
