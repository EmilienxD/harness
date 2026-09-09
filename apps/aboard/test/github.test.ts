import assert from "node:assert/strict";
import test from "node:test";

import { GitHubBoundaryError, GitHubClient, ProcessGhExecutor, type GhExecutor } from "../src/github/client.js";
import { PromptResolutionError, PromptResolver } from "../src/claude/prompts.js";

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
const endPage = { hasNextPage: false, endCursor: null };

const missingIssueResponse = {
  data: { repository: { issue: null } },
  errors: [{ type: "NOT_FOUND", path: ["repository", "issue"] }],
};

test("a CLI lookup failure for a missing context issue does not block implementation", async () => {
  const fetched: number[] = [];
  const github = new GitHubClient(new ProcessGhExecutor("fixture", async (args) => {
    if (args[0] === "repo") return repo;
    const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
    fetched.push(number);
    if (number === 336) {
      throw { code: 1, stdout: JSON.stringify(missingIssueResponse), stderr: "gh: missing issue" };
    }
    assert.ok(number === 337 || number === 332);
    return graph({ issue: {
      number, title: `Issue ${number}`, body: number === 337 ? "Depends on #336." : "Parent context",
      state: "OPEN", labels: { nodes: [], pageInfo: endPage },
      parent: number === 337 ? { number: 332 } : null,
    } });
  }));
  const resolver = new PromptResolver({ github });
  const prompt = await resolver.resolve({
    kind: "implementation", instruction: "Implement the issue", issueNumbers: [337], issueContextDepth: 2,
  });
  assert.deepEqual(fetched, [337, 332, 336]);
  assert.deepEqual(prompt?.sources.map((source) => source.number), [337, 332]);
  await assert.rejects(
    resolver.resolve({ kind: "implementation", instruction: "Implement", issueNumbers: [336] }),
    (error: unknown) => error instanceof PromptResolutionError && error.code === "issue-not-found",
  );
});

test("only an exact GraphQL issue NOT_FOUND response becomes an absent issue", async () => {
  const failures = [
    { stdout: "not JSON" },
    { stdout: JSON.stringify({ data: { repository: { issue: null } }, errors: [] }) },
    { stdout: JSON.stringify({ ...missingIssueResponse, errors: [{ type: "FORBIDDEN", path: ["repository", "issue"] }] }) },
    { stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"] }] }) },
    { stdout: JSON.stringify({ ...missingIssueResponse, errors: [{ type: "NOT_FOUND", path: ["repository", "issue", "parent"] }] }) },
    { stdout: JSON.stringify({ ...missingIssueResponse, errors: [...missingIssueResponse.errors, { type: "RATE_LIMITED" }] }) },
    { stdout: JSON.stringify({ ...missingIssueResponse, data: { repository: { issue: { number: 337 } } } }) },
    { code: "ENOENT" },
  ];
  for (const failure of failures) {
    const github = new GitHubClient(new ProcessGhExecutor("fixture", async (args) => {
      if (args[0] === "repo") return repo;
      throw { code: 1, stderr: "diagnostic", ...failure };
    }));
    await assert.rejects(github.getIssue(337), (error: unknown) => {
      assert.ok(error instanceof GitHubBoundaryError);
      assert.equal(error.code, "command-failed");
      assert.equal((error.details as { stderr: string }).stderr, "diagnostic");
      assert.equal(Object.hasOwn(error.details as object, "stdout"), false);
      return true;
    });
  }
});

test("authentication preflight is fresh, targets the workspace repository, and primes GraphQL identity", async () => {
  let failing = true;
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") {
      assert.deepEqual(args, ["repo", "view", "--json", "owner,name"]);
      if (failing) throw new GitHubBoundaryError("command-failed", "GitHub CLI command failed");
      return repo;
    }
    return graph({ issues: { nodes: [], pageInfo: endPage } });
  });
  const github = new GitHubClient(gh);

  await assert.rejects(
    () => github.checkAuthentication(),
    (error: unknown) => error instanceof GitHubBoundaryError && error.code === "command-failed",
  );
  failing = false;
  await github.checkAuthentication();
  assert.deepEqual((await github.listImplementableIssues()).candidates, []);

  assert.equal(gh.calls.filter((args) => args[0] === "repo").length, 2);
  assert.equal(gh.calls.filter((args) => args[0] === "api").length, 1);
});


/** One page of open issues as the GraphQL query returns it. */
function openIssues(): string {
  const nodes = [
    { number: 16, title: "ready hitl", body: "Needs #18 and https://github.com/EmilienxD/aboard/issues/17; ignore https://github.com/other/repo/issues/99 and `#77`.", createdAt: "2026-01-01T00:00:00Z", labels: { nodes: [{ name: "[AI]-hitl" }], pageInfo: endPage }, subIssues: { nodes: [], totalCount: 0, pageInfo: endPage }, blockedBy: { nodes: [{ number: 15, state: "CLOSED" }], pageInfo: endPage } },
    { number: 17, title: "blocked afk", createdAt: "2026-01-02T00:00:00Z", labels: { nodes: [{ name: "[AI]-afk" }], pageInfo: endPage }, subIssues: { totalCount: 0 }, blockedBy: { nodes: [{ number: 16, state: "OPEN" }], pageInfo: endPage } },
    { number: 18, title: "unclassified", createdAt: "2026-01-03T00:00:00Z", labels: { nodes: [], pageInfo: endPage }, subIssues: { totalCount: 0 }, blockedBy: { nodes: [], pageInfo: endPage } },
    { number: 19, title: "parent issue", createdAt: "2026-01-04T00:00:00Z", labels: { nodes: [{ name: "planning" }], pageInfo: endPage }, subIssues: { nodes: [{ number: 16 }], totalCount: 3, pageInfo: endPage }, blockedBy: { nodes: [], pageInfo: endPage } },
  ];
  return graph({ issues: { nodes, pageInfo: endPage } });
}


test("the Auto Run queue preserves open issue ordering, classification labels, and dependencies", async () => {
  const gh = new FixtureGh((args) => args[0] === "repo" ? repo : openIssues());
  const github = new GitHubClient(gh);
  const { candidates } = await github.listImplementableIssues();

  assert.deepEqual(candidates.map((issue) => issue.number), [16, 17, 18, 19]);
  assert.deepEqual(candidates.map((issue) => issue.createdAt), [
    "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z",
  ]);
  assert.deepEqual(candidates.find((issue) => issue.number === 17)?.openBlockedByNumbers, [16]);
  assert.deepEqual(candidates.find((issue) => issue.number === 16)?.openBlockedByNumbers, []);
  assert.deepEqual(candidates.find((issue) => issue.number === 16)?.dependencyNumbers, [15, 18, 17]);
  assert.deepEqual(candidates.find((issue) => issue.number === 19)?.dependencyNumbers, [16]);

  assert.deepEqual(candidates.map((issue) => issue.labels), [["[AI]-hitl"], ["[AI]-afk"], [], ["planning"]]);

  // Ascending creation order establishes priority before cursor pagination.
  const query = gh.calls.flat().find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /orderBy:\{field:CREATED_AT,direction:ASC\}/);
  assert.match(query, /subIssues\(first:100\)\{nodes\{number\} pageInfo/);
  assert.match(query, /pageInfo\{hasNextPage endCursor\}/);
});

test("the queue paginates past one hundred unclassified issues", async () => {
  const oldUnclassified = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    title: `Unclassified ${index + 1}`,
    createdAt: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
    labels: { nodes: [{ name: "planning" }], pageInfo: endPage },
    subIssues: { totalCount: 1 },
    blockedBy: { nodes: [], pageInfo: endPage },
  }));
  const implementable = {
    number: 101,
    title: "Newest work",
    createdAt: "2026-01-01T00:00:00Z",
    labels: { nodes: [{ name: "[AI]-afk" }], pageInfo: endPage },
    subIssues: { totalCount: 0 },
    blockedBy: { nodes: [], pageInfo: endPage },
  };
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    const secondPage = args.includes("after=issues-100");
    return graph({ issues: secondPage
      ? { nodes: [implementable], pageInfo: endPage }
      : { nodes: oldUnclassified, pageInfo: { hasNextPage: true, endCursor: "issues-100" } } });
  });
  const { candidates } = await new GitHubClient(gh).listImplementableIssues();
  assert.equal(candidates.length, 101);
  assert.equal(candidates.at(-1)?.number, 101);
  assert.equal(gh.calls.some((args) => args.includes("after=issues-100")), true);
});

test("label and blocker connections are completed before queue classification", async () => {
  const initial = {
    number: 42,
    title: "Deep connections",
    createdAt: "2026-01-01T00:00:00Z",
    labels: { nodes: [{ name: "enhancement" }], pageInfo: { hasNextPage: true, endCursor: "labels-100" } },
    subIssues: { nodes: [{ number: 2 }], totalCount: 2, pageInfo: { hasNextPage: true, endCursor: "children-100" } },
    blockedBy: { nodes: [{ number: 1, state: "CLOSED" }], pageInfo: { hasNextPage: true, endCursor: "blocked-100" } },
  };
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("labels(first:100,after:$after)")) {
      return graph({ issue: { labels: { nodes: [{ name: "[AI]-afk" }], pageInfo: endPage } } });
    }
    if (query.includes("blockedBy(first:100,after:$after)")) {
      return graph({ issue: { blockedBy: { nodes: [{ number: 999, state: "OPEN" }], pageInfo: endPage } } });
    }
    if (query.includes("subIssues(first:100,after:$after)")) {
      return graph({ issue: { subIssues: { nodes: [{ number: 3 }], totalCount: 2, pageInfo: endPage } } });
    }
    return graph({ issues: { nodes: [initial], pageInfo: endPage } });
  });
  const candidate = (await new GitHubClient(gh).listImplementableIssues()).candidates[0];
  assert.deepEqual(candidate?.labels, ["enhancement", "[AI]-afk"]);
  assert.deepEqual(candidate?.openBlockedByNumbers, [999]);
  assert.deepEqual(candidate?.dependencyNumbers, [1, 999, 2, 3]);
  assert.equal(gh.calls.some((args) => args.includes("after=labels-100")), true);
  assert.equal(gh.calls.some((args) => args.includes("after=blocked-100")), true);
  assert.equal(gh.calls.some((args) => args.includes("after=children-100")), true);
});

test("an issue prompt receives labels beyond the first connection page", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("labels(first:100,after:$after)")) {
      return graph({ issue: { labels: { nodes: [{ name: "[AI]-hitl" }], pageInfo: endPage } } });
    }
    return graph({ issue: {
      number: 17,
      title: "Review",
      body: "Contract",
      state: "OPEN",
      labels: { nodes: [{ name: "enhancement" }], pageInfo: { hasNextPage: true, endCursor: "labels-100" } },
      parent: null,
    } });
  });
  assert.deepEqual((await new GitHubClient(gh).getIssue(17))?.labels, ["enhancement", "[AI]-hitl"]);
  assert.equal(gh.calls.some((args) => args.includes("after=labels-100")), true);
});

test("resolves issue parent, PR state, diff, and publishes line comments", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    if (args[0] === "pr" && args[1] === "diff") return "diff --git a/a.ts b/a.ts";
    if (args[0] === "api" && args[1]?.startsWith("repos/")) return "{}";
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("subIssues(first:100,after:$after)")) return graph({ issue: { subIssues: { nodes: [{ number: 24 }], totalCount: 2, pageInfo: endPage } } });
    if (query.includes("issue(number")) return graph({ issue: { number: 17, title: "Review", body: "Contract depends on #23.", state: "OPEN", labels: { nodes: [{ name: "[AI]-hitl" }], pageInfo: endPage }, parent: { number: 9 }, subIssues: { nodes: [{ number: 22 }], totalCount: 2, pageInfo: { hasNextPage: true, endCursor: "children-100" } } } });
    return graph({ pullRequest: { number: 42, title: "PR", body: "Body", state: "OPEN", merged: false, mergeable: "CONFLICTING", url: "https://github.com/acme/app/pull/42", headRefName: "feat/17", baseRefName: "main", headRefOid: "abc123", closingIssuesReferences: { nodes: [{ number: 17 }] }, reviewDecision: null, reviewThreads: { nodes: [{ isResolved: false }] } } });
  });
  const github = new GitHubClient(gh);
  assert.equal((await github.getIssue(17))?.parentIssueNumber, 9);
  assert.deepEqual((await github.getIssue(17))?.dependencyIssueNumbers, [22, 23, 24]);
  assert.equal((await github.getPullRequest(42))?.issueNumber, 17);
  // Mergeability decides whether auto-run parks an issue or stops the run.
  assert.equal((await github.getPullRequest(42))?.mergeable, "conflicting");
  assert.equal((await github.getPullRequest(42))?.url, "https://github.com/acme/app/pull/42");
  assert.equal(await github.getPullRequestDiff(42), "diff --git a/a.ts b/a.ts");
  assert.deepEqual(await github.getReviewState(42), { decision: "unreviewed", unresolvedThreadCount: 1 });
  await github.publishReviewFinding(42, { body: "Null crash", path: "src/a.ts", line: 7 });
  assert.equal(gh.calls.some((args) => args.includes("path=src/a.ts") && args.includes("line=7")), true);
});

test("resolves issue comments in API order across every page", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("comments(first:100,after:$after)")) {
      return graph({ issue: { comments: {
        nodes: [{ author: null, body: "Newest" }],
        pageInfo: endPage,
      } } });
    }
    return graph({ issue: {
      number: 17,
      title: "Review",
      body: "Contract",
      state: "OPEN",
      labels: { nodes: [], pageInfo: endPage },
      parent: null,
      subIssues: { nodes: [], pageInfo: endPage },
      comments: {
        nodes: [{ author: { login: "alice" }, body: "Oldest" }],
        pageInfo: { hasNextPage: true, endCursor: "comments-100" },
      },
    } });
  });

  assert.deepEqual((await new GitHubClient(gh).getIssue(17))?.comments, [
    { authorLogin: "alice", body: "Oldest" },
    { body: "Newest" },
  ]);
  assert.equal(gh.calls.some((args) => args.includes("after=comments-100")), true);
});

test("mergeability GitHub has not computed yet reads as unknown rather than as a failure", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    return graph({ pullRequest: { number: 42, title: "PR", body: "", state: "OPEN", merged: false, mergeable: "UNKNOWN", url: "https://github.com/acme/app/pull/42", headRefName: "feat/17", baseRefName: "main", headRefOid: "abc123", closingIssuesReferences: { nodes: [] }, reviewDecision: null, reviewThreads: { nodes: [] } } });
  });
  assert.equal((await new GitHubClient(gh).getPullRequest(42))?.mergeable, "unknown");
});

test("an issue comment is posted with the body it was given", async () => {
  const gh = new FixtureGh(() => "");
  await new GitHubClient(gh).addIssueComment(34, "Rewrote the backoff.");
  assert.deepEqual(gh.calls, [["issue", "comment", "34", "--body", "Rewrote the backoff."]]);
});

test("an issue is closed as completed with the comment explaining the closure", async () => {
  const gh = new FixtureGh(() => "");
  await new GitHubClient(gh).closeIssue(34, "Merged into `run/k3f9x1`.");
  assert.deepEqual(gh.calls, [["issue", "close", "34", "--reason", "completed", "--comment", "Merged into `run/k3f9x1`."]]);
});

test("branch deletion on merge is the caller's decision, not the boundary's", async () => {
  // Deleting a base branch closes every pull request still targeting it, which
  // is why a run's session branch is merged without it.
  const withDelete = new FixtureGh(() => "");
  await new GitHubClient(withDelete).mergePullRequest(56, "squash", true);
  assert.deepEqual(withDelete.calls, [["pr", "merge", "56", "--squash", "--delete-branch"]]);

  const withoutDelete = new FixtureGh(() => "");
  await new GitHubClient(withoutDelete).mergePullRequest(57, "merge", false);
  assert.deepEqual(withoutDelete.calls, [["pr", "merge", "57", "--merge"]]);
});

test("branch pull request recovery can observe closed and merged records", async () => {
  const gh = new FixtureGh(() => JSON.stringify([{ number: 58 }]));
  assert.equal(await new GitHubClient(gh).findPullRequestForBranch("issue/34-fix"), 58);
  assert.deepEqual(gh.calls, [["pr", "list", "--state", "all", "--head", "issue/34-fix", "--limit", "1", "--json", "number"]]);
});

test("a pull request snapshot carries its review decision without a second query", async () => {
  const gh = new FixtureGh((args) => args[0] === "repo" ? repo : graph({ pullRequest: { number: 42, title: "PR", body: "", state: "OPEN", merged: false, mergeable: "MERGEABLE", url: "https://github.com/acme/app/pull/42", headRefName: "feat/17", baseRefName: "main", headRefOid: "abc123", closingIssuesReferences: { nodes: [] }, reviewDecision: "APPROVED", reviewThreads: { nodes: [] } } }));
  assert.equal((await new GitHubClient(gh).getPullRequest(42))?.reviewDecision, "approved");
});

test("head-branch pull request lookups batch into one GraphQL query", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "repo") return repo;
    return graph({
      b0: { nodes: [{ number: 58 }] },
      b1: { nodes: [] },
      b2: { nodes: [{ number: 61 }] },
    });
  });
  const found = await new GitHubClient(gh).findPullRequestsByHead(["issue/34-fix", "issue/35-two", "issue/36-three"]);
  assert.deepEqual([...found], [["issue/34-fix", 58], ["issue/36-three", 61]]);
  const query = gh.calls.map((args) => args.find((arg) => arg.startsWith("query=")) ?? "").find((q) => q.includes("pullRequests"));
  // One round trip: every branch is an aliased field carrying its own variable.
  assert.ok(query?.includes("b0:pullRequests(headRefName:$h0"));
  assert.ok(query?.includes("b2:pullRequests(headRefName:$h2"));
  const variables = gh.calls.flatMap((args) => args).filter((arg) => arg.startsWith("h") && arg.includes("=issue/"));
  assert.equal(variables.length, 3);
});

test("branch cleanup finds pull requests where an aboard branch is either head or base", async () => {
  const gh = new FixtureGh(() => JSON.stringify([
    { number: 58, title: "Issue work", state: "OPEN", headRefName: "issue/34-fix", baseRefName: "run/old" },
    { number: 59, title: "Unrelated", state: "MERGED", headRefName: "feature/x", baseRefName: "main" },
  ]));
  assert.deepEqual(await new GitHubClient(gh).listPullRequestsForBranches(["run/old"]), [
    { number: 58, title: "Issue work", state: "open", head: "issue/34-fix", base: "run/old" },
  ]);
  assert.deepEqual(gh.calls, [["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,title,state,headRefName,baseRefName"]]);
});

test("closing a pull request checks its identity and state before mutating anything", async () => {
  const pullRequest = (overrides: Record<string, unknown>) => ({
    number: 57, title: "PR", body: "", merged: false, state: "OPEN", mergeable: "MERGEABLE",
    url: "https://github.com/acme/app/pull/57", headRefName: "issue/35-two", baseRefName: "run/test",
    headRefOid: "abc123", closingIssuesReferences: { nodes: [] }, reviewDecision: null, reviewThreads: { nodes: [] },
    ...overrides,
  });
  const client = (overrides: Record<string, unknown>) => {
    const gh = new FixtureGh((args) => args[0] === "repo" ? repo : graph({ pullRequest: pullRequest(overrides) }));
    return { gh, github: new GitHubClient(gh) };
  };
  const closed = (gh: FixtureGh) => gh.calls.some((args: readonly string[]) => args[0] === "pr" && args[1] === "close");

  const matching = client({});
  assert.equal(await matching.github.closePullRequestIf(57, { head: "issue/35-two", base: "run/test" }), true);
  assert.ok(matching.gh.calls.some((args) => args.join(" ") === "pr close 57"));

  const retargeted = client({ baseRefName: "main" });
  assert.equal(await retargeted.github.closePullRequestIf(57, { head: "issue/35-two", base: "run/test" }), false);
  assert.equal(closed(retargeted.gh), false);

  const rehomed = client({ headRefName: "somebody/else" });
  assert.equal(await rehomed.github.closePullRequestIf(57, { head: "issue/35-two", base: "run/test" }), false);
  assert.equal(closed(rehomed.gh), false);

  const merged = client({ merged: true });
  assert.equal(await merged.github.closePullRequestIf(57, { head: "issue/35-two", base: "run/test" }), false);
  assert.equal(closed(merged.gh), false);

  const gone = new FixtureGh((args) => args[0] === "repo" ? repo : graph({ pullRequest: null }));
  assert.equal(await new GitHubClient(gone).closePullRequestIf(57, { head: "issue/35-two", base: "run/test" }), false);
  assert.equal(closed(gone), false);
});

test("a tree row can open the issue or pull request it names", async () => {
  const gh = new FixtureGh(() => repo);
  // GitHub serves /issues/<n> and /pull/<n> interchangeably, so one builder
  // answers both without a round trip to find out which the number is.
  assert.equal(await new GitHubClient(gh).webUrl(34), "https://github.com/EmilienxD/aboard/issues/34");
});

test("malformed gh JSON is a typed boundary failure", async () => {
  await assert.rejects(() => new GitHubClient(new FixtureGh(() => "not-json")).listImplementableIssues(), (error: unknown) => error instanceof GitHubBoundaryError && error.code === "malformed-output");
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
