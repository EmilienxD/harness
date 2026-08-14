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

/** Open issues carrying `ai:todo`, as `gh issue list --json number,body,createdAt` returns them. */
function carriers(...issues: readonly { number: number; body: string; createdAt: string }[]): string {
  return JSON.stringify(issues);
}

const ROADMAP = "- [ ] Ship the bridge\n- [x] Rotate the tokens";

function roadmapGh(response: (args: readonly string[]) => string): FixtureGh {
  return new FixtureGh((args) => {
    if (args[0] === "issue" && args[1] === "edit") return "";
    if (args[0] === "label") return "";
    return response(args);
  });
}

test("one label query resolves the locator and the document, with no cache and no search index", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return carriers({ number: 12, body: ROADMAP, createdAt: "2026-07-01T00:00:00Z" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  const roadmap = await github.readRoadmap();
  assert.equal(roadmap?.number, 12);
  assert.deepEqual(roadmap?.tasks.map((task) => [task.subject, task.completed]), [["Ship the bridge", false], ["Rotate the tokens", true]]);
  assert.equal(roadmap?.carrierCount, 1);

  // `--search` would move the query onto GitHub's asynchronously indexed search
  // API, where an issue created seconds ago can be missing — and a missing
  // carrier mints a duplicate roadmap. The sort is done client-side instead.
  const lookup = gh.calls.find((args) => args[0] === "issue" && args[1] === "list");
  assert.equal(lookup?.includes("--search"), false);
  assert.deepEqual(lookup, ["issue", "list", "--state", "open", "--label", "ai:todo", "--limit", "50", "--json", "number,body,createdAt"]);

  // A second read re-resolves: the cache it replaced saved nothing, because
  // every use of it had to revalidate at exactly the cost of resolving.
  await github.readRoadmap();
  assert.equal(gh.calls.filter((args) => args[0] === "issue" && args[1] === "list").length, 2);
});

test("newest carrier wins, ties break on the lowest number, and read and write agree", async () => {
  const listed = carriers(
    { number: 50, body: "- [ ] Fifty", createdAt: "2026-07-02T00:00:00Z" },
    { number: 3, body: "- [ ] Three", createdAt: "2026-07-09T00:00:00Z" },
    { number: 9, body: "- [ ] Nine", createdAt: "2026-07-09T00:00:00Z" },
  );
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return listed;
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  // Newest createdAt, then the lower number among the two that tie.
  assert.equal((await github.readRoadmap())?.number, 3);
  assert.equal((await github.createRoadmapTasks({ subjects: ["Added"] })).issue, 3);
  assert.deepEqual(gh.calls.filter((args) => args[1] === "edit").at(-1)?.slice(0, 3), ["issue", "edit", "3"]);
});

test("extra carriers are reported, never repaired", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return carriers({ number: 50, body: "- [ ] Fifty", createdAt: "2026-07-09T00:00:00Z" }, { number: 3, body: "- [ ] Three", createdAt: "2026-07-02T00:00:00Z" });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  assert.equal((await github.readRoadmap())?.carrierCount, 2);
  const written = await github.createRoadmapTasks({ subjects: ["Added"] });
  assert.equal(written.issue, 50);
  assert.match(written.notices.join(" "), /2 open issues carry `ai:todo`; #50 is in use/);
  // aboard never modifies an issue it did not create: no relabelling, and no
  // third issue minted to escape the ambiguity.
  assert.equal(gh.calls.some((args) => args.includes("--remove-label")), false);
  assert.equal(gh.calls.some((args) => args[0] === "issue" && args[1] === "create"), false);
});

test("an empty candidate set mints on create, is the first-run state on read, and fails on update", async () => {
  const empty = (args: readonly string[]) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/EmilienxD/aboard/issues/44\n";
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  // No carrier is a fact about the repository, not a failure: the briefing
  // renders it as work to do rather than as an unavailable section.
  assert.equal(await new GitHubClient(roadmapGh(empty)).readRoadmap(), undefined);

  const createGh = roadmapGh(empty);
  const created = await new GitHubClient(createGh).createRoadmapTasks({ subjects: ["Write the first task"] });
  assert.equal(created.issue, 44);
  assert.equal(created.ids?.length, 1);
  assert.match(created.notices.join(" "), /Created issue #44/);
  // Plain `label create`, so a user-owned `ai:todo` keeps its colour.
  assert.equal(createGh.calls.some((args) => args.includes("--force")), false);
  assert.deepEqual(createGh.calls.find((args) => args[0] === "issue" && args[1] === "create")?.slice(0, 4), ["issue", "create", "--title", "Project roadmap"]);

  await assert.rejects(
    () => new GitHubClient(roadmapGh(empty)).updateRoadmapTask({ task: "a3f9", status: "completed" }),
    (error: unknown) => error instanceof GitHubBoundaryError && error.code === "missing-todo",
  );
});

test("a batch create is one issue edit, returns ids in order, and honours --after", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return carriers({ number: 12, body: "- [ ] First\n- [ ] Second", createdAt: "2026-07-01T00:00:00Z" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  const created = await github.createRoadmapTasks({ subjects: ["Third", "Fourth"], after: "top" });
  assert.equal(created.ids?.length, 2);
  // One write for N subjects: the bootstrap must not cost twenty issue revisions.
  assert.equal(gh.calls.filter((args) => args[0] === "issue" && args[1] === "edit").length, 1);
  assert.equal(gh.calls.find((args) => args[1] === "edit")?.at(-1), "- [ ] Third\n- [ ] Fourth\n- [ ] First\n- [ ] Second");
});

test("an unknown task id writes nothing and returns the current numbered list", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return carriers({ number: 12, body: ROADMAP, createdAt: "2026-07-01T00:00:00Z" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  await assert.rejects(
    () => new GitHubClient(gh).updateRoadmapTask({ task: "zzzz", status: "completed" }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubBoundaryError && error.code === "unknown-task");
      const details = (error as GitHubBoundaryError).details as { tasks: readonly string[] };
      assert.equal(details.tasks.length, 2);
      assert.match(details.tasks[0] as string, /^1\. \[[0-9a-f]{4}\] pending - Ship the bridge$/);
      return true;
    },
  );
  assert.equal(gh.calls.some((args) => args[0] === "issue" && args[1] === "edit"), false);
});

test("the size bound accepts the write and warns rather than deadlocking the Manager", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return carriers({ number: 12, body: `- [ ] ${"x".repeat(60_000)}`, createdAt: "2026-07-01T00:00:00Z" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const written = await new GitHubClient(gh).createRoadmapTasks({ subjects: ["One more"] });
  assert.match(written.notices.join(" "), /past the 60000 bound. The write was accepted/);
  assert.equal(gh.calls.some((args) => args[0] === "issue" && args[1] === "edit"), true);
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
  await assert.rejects(() => new GitHubClient(new FixtureGh(() => "not-json")).readRoadmap(), (error: unknown) => error instanceof GitHubBoundaryError && error.code === "malformed-output");
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
