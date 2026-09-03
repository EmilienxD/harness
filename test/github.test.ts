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
    kind: "implementation", instruction: "Implement the issue", issueNumbers: [337], recursiveIssueReferences: false,
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

/** Open issues carrying `[AI]-todo`, as `gh issue list --json number,body,createdAt` returns them. */
function carriers(...issues: readonly { number: number; body: string; createdAt: string }[]): string {
  return JSON.stringify(issues);
}

const ROADMAP = "- [ ] Ship the bridge\n- [x] Rotate the tokens";

function roadmapGh(response: (args: readonly string[]) => string): FixtureGh {
  return new FixtureGh((args) => {
    if (args[0] === "issue" && args[1] === "edit") return "";
    if (args[0] === "issue" && args[1] === "pin") return "";
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

  const lookup = gh.calls.find((args) => args[0] === "issue" && args[1] === "list");
  assert.equal(lookup?.includes("--search"), false);
  assert.deepEqual(lookup, ["issue", "list", "--state", "open", "--label", "[AI]-todo", "--limit", "50", "--json", "number,body,createdAt"]);

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
  assert.match(written.notices.join(" "), /2 open issues carry `\[AI\]-todo`; #50 is in use/);
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
  assert.deepEqual(created.positions, [1]);
  assert.match(created.notices.join(" "), /Created issue #44/);
  // Plain `label create`, so a user-owned `[AI]-todo` keeps its colour.
  assert.equal(createGh.calls.some((args) => args.includes("--force")), false);
  assert.deepEqual(createGh.calls.find((args) => args[0] === "issue" && args[1] === "create")?.slice(0, 4), ["issue", "create", "--title", "Project roadmap"]);
  assert.deepEqual(createGh.calls.find((args) => args[0] === "issue" && args[1] === "pin"), ["issue", "pin", "44"]);

  await assert.rejects(
    () => new GitHubClient(roadmapGh(empty)).updateRoadmapTask({ task: 1, expect: "Anything", status: "completed" }),
    (error: unknown) => error instanceof GitHubBoundaryError && error.code === "missing-todo",
  );
});

test("roadmap issue pinning is best effort after minting", async () => {
  const gh = new FixtureGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "label") return "";
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/EmilienxD/aboard/issues/44\n";
    if (args[0] === "issue" && args[1] === "pin") throw new GitHubBoundaryError("command-failed", "pin failed");
    if (args[0] === "issue" && args[1] === "view") {
      return viewed({ number: 44, body: "- [ ] Write the first task", createdAt: "2026-07-09T00:00:00Z", state: "OPEN", labels: ["[AI]-todo"] });
    }
    if (args[0] === "issue" && args[1] === "edit") return "";
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  const created = await github.createRoadmapTasks({ subjects: ["Write the first task"] });
  assert.equal(created.issue, 44);
  assert.match(created.notices.join(" "), /could not pin #44/);

  await github.updateRoadmapTask({ task: 1, expect: "Write the first task", status: "completed" });
  assert.equal(gh.calls.filter((args) => args[0] === "issue" && args[1] === "create").length, 1);
  assert.deepEqual(gh.calls.find((args) => args[0] === "issue" && args[1] === "edit")?.slice(0, 3), ["issue", "edit", "44"]);
});

test("a batch create is one issue edit, returns positions in order, and honours --after", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return carriers({ number: 12, body: "- [ ] First\n- [ ] Second", createdAt: "2026-07-01T00:00:00Z" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  const created = await github.createRoadmapTasks({ subjects: ["Third", "Fourth"], after: "top" });
  assert.deepEqual(created.positions, [1, 2]);
  // One write for N subjects: the bootstrap must not cost twenty issue revisions.
  assert.equal(gh.calls.filter((args) => args[0] === "issue" && args[1] === "edit").length, 1);
  assert.equal(gh.calls.find((args) => args[1] === "edit")?.at(-1), "- [ ] Third\n- [ ] Fourth\n- [ ] First\n- [ ] Second");
});

test("an edit that renumbers hands back the pending list; one that does not stays quiet", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return carriers({ number: 12, body: ROADMAP, createdAt: "2026-07-01T00:00:00Z" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);

  // A move renumbers everything between, so the caller's held positions are
  // stale and it is handed the current list rather than left to discover that.
  const moved = await github.updateRoadmapTask({ task: 2, expect: "Rotate the tokens", after: "top" });
  assert.deepEqual(moved.tasks, ["2. [ ] Ship the bridge"]);
  assert.match(moved.notices.join(" "), /renumbered the tasks after it/);

  // Completing a task in place moves nothing, so nothing is owed.
  const completed = await github.updateRoadmapTask({ task: 1, expect: "Ship the bridge", status: "completed" });
  assert.equal(completed.tasks, undefined);
  assert.equal(completed.task, 1);

  const appended = await github.createRoadmapTasks({ subjects: ["Later"] });
  assert.equal(appended.tasks, undefined);
});

test("an out-of-range position writes nothing and returns the current list", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return carriers({ number: 12, body: ROADMAP, createdAt: "2026-07-01T00:00:00Z" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  await assert.rejects(
    () => new GitHubClient(gh).updateRoadmapTask({ task: 9, expect: "Ship the bridge", status: "completed" }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubBoundaryError && error.code === "unknown-task");
      const details = (error as GitHubBoundaryError).details as { tasks: readonly string[] };
      assert.deepEqual(details.tasks, ["1. [ ] Ship the bridge", "2. [x] Rotate the tokens"]);
      return true;
    },
  );
  assert.equal(gh.calls.some((args) => args[0] === "issue" && args[1] === "edit"), false);
});

test("an expect mismatch writes nothing and returns the current list", async () => {
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return carriers({ number: 12, body: ROADMAP, createdAt: "2026-07-01T00:00:00Z" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  await assert.rejects(
    () => new GitHubClient(gh).updateRoadmapTask({ task: 1, expect: "Rotate the tokens", status: "completed" }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubBoundaryError && error.code === "expectation-mismatch");
      assert.match(error.message, /Position 1 is "Ship the bridge", not "Rotate the tokens"/);
      const details = (error as GitHubBoundaryError).details as { tasks: readonly string[] };
      assert.deepEqual(details.tasks, ["1. [ ] Ship the bridge", "2. [x] Rotate the tokens"]);
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

test("derives readiness solely from dependency closedness and flags classification", async () => {
  const gh = new FixtureGh((args) => args[0] === "repo" ? repo : openIssues());
  const issues = await new GitHubClient(gh).listRoadmapIssues();
  assert.deepEqual(issues.map((issue) => [issue.number, issue.ready, issue.disposition]), [
    [16, true, "hitl"], [17, false, "afk"], [18, true, "unclassified"], [19, true, "unclassified"],
  ]);
});

test("the queue and the briefing are projected from one open-issue read", async () => {
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

  const briefing = await github.listRoadmapIssues();
  for (const issue of briefing) {
    const candidate = candidates.find((entry) => entry.number === issue.number);
    assert.equal(issue.ready, candidate?.openBlockedByNumbers.length === 0);
    assert.equal(issue.title, candidate?.title);
  }

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
  await new GitHubClient(gh).closeIssue(34, "Merged into `aboard/run/k3f9x1`.");
  assert.deepEqual(gh.calls, [["issue", "close", "34", "--reason", "completed", "--comment", "Merged into `aboard/run/k3f9x1`."]]);
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
  assert.equal(await new GitHubClient(gh).findPullRequestForBranch("aboard/34-fix"), 58);
  assert.deepEqual(gh.calls, [["pr", "list", "--state", "all", "--head", "aboard/34-fix", "--limit", "1", "--json", "number"]]);
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
  const found = await new GitHubClient(gh).findPullRequestsByHead(["aboard/34-fix", "aboard/35-two", "aboard/36-three"]);
  assert.deepEqual([...found], [["aboard/34-fix", 58], ["aboard/36-three", 61]]);
  const query = gh.calls.map((args) => args.find((arg) => arg.startsWith("query=")) ?? "").find((q) => q.includes("pullRequests"));
  // One round trip: every branch is an aliased field carrying its own variable.
  assert.ok(query?.includes("b0:pullRequests(headRefName:$h0"));
  assert.ok(query?.includes("b2:pullRequests(headRefName:$h2"));
  const variables = gh.calls.flatMap((args) => args).filter((arg) => arg.startsWith("h") && arg.includes("=aboard/"));
  assert.equal(variables.length, 3);
});

test("branch cleanup finds pull requests where an aboard branch is either head or base", async () => {
  const gh = new FixtureGh(() => JSON.stringify([
    { number: 58, title: "Issue work", state: "OPEN", headRefName: "aboard/34-fix", baseRefName: "aboard/run/old" },
    { number: 59, title: "Unrelated", state: "MERGED", headRefName: "feature/x", baseRefName: "main" },
  ]));
  assert.deepEqual(await new GitHubClient(gh).listPullRequestsForBranches(["aboard/run/old"]), [
    { number: 58, title: "Issue work", state: "open", head: "aboard/34-fix", base: "aboard/run/old" },
  ]);
  assert.deepEqual(gh.calls, [["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,title,state,headRefName,baseRefName"]]);
});

test("closing a pull request checks its identity and state before mutating anything", async () => {
  const pullRequest = (overrides: Record<string, unknown>) => ({
    number: 57, title: "PR", body: "", merged: false, state: "OPEN", mergeable: "MERGEABLE",
    url: "https://github.com/acme/app/pull/57", headRefName: "aboard/35-two", baseRefName: "aboard/run/test",
    headRefOid: "abc123", closingIssuesReferences: { nodes: [] }, reviewDecision: null, reviewThreads: { nodes: [] },
    ...overrides,
  });
  const client = (overrides: Record<string, unknown>) => {
    const gh = new FixtureGh((args) => args[0] === "repo" ? repo : graph({ pullRequest: pullRequest(overrides) }));
    return { gh, github: new GitHubClient(gh) };
  };
  const closed = (gh: FixtureGh) => gh.calls.some((args: readonly string[]) => args[0] === "pr" && args[1] === "close");

  const matching = client({});
  assert.equal(await matching.github.closePullRequestIf(57, { head: "aboard/35-two", base: "aboard/run/test" }), true);
  assert.ok(matching.gh.calls.some((args) => args.join(" ") === "pr close 57"));

  const retargeted = client({ baseRefName: "main" });
  assert.equal(await retargeted.github.closePullRequestIf(57, { head: "aboard/35-two", base: "aboard/run/test" }), false);
  assert.equal(closed(retargeted.gh), false);

  const rehomed = client({ headRefName: "somebody/else" });
  assert.equal(await rehomed.github.closePullRequestIf(57, { head: "aboard/35-two", base: "aboard/run/test" }), false);
  assert.equal(closed(rehomed.gh), false);

  const merged = client({ merged: true });
  assert.equal(await merged.github.closePullRequestIf(57, { head: "aboard/35-two", base: "aboard/run/test" }), false);
  assert.equal(closed(merged.gh), false);

  const gone = new FixtureGh((args) => args[0] === "repo" ? repo : graph({ pullRequest: null }));
  assert.equal(await new GitHubClient(gone).closePullRequestIf(57, { head: "aboard/35-two", base: "aboard/run/test" }), false);
  assert.equal(closed(gone), false);
});

test("a tree row can open the issue or pull request it names", async () => {
  const gh = new FixtureGh(() => repo);
  // GitHub serves /issues/<n> and /pull/<n> interchangeably, so one builder
  // answers both without a round trip to find out which the number is.
  assert.equal(await new GitHubClient(gh).webUrl(34), "https://github.com/EmilienxD/aboard/issues/34");
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

/** `gh issue view <n> --json number,body,createdAt,state,labels`. */
function viewed(issue: { number: number; body: string; createdAt: string; state: string; labels: readonly string[] }): string {
  return JSON.stringify({ ...issue, labels: issue.labels.map((name) => ({ name })) });
}

test("an update straight after a mint resolves the new issue the label index has not indexed yet", async () => {
  let indexed = false;
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return indexed ? carriers({ number: 44, body: "- [ ] Write the first task", createdAt: "2026-07-09T00:00:00Z" }) : "[]";
    }
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/EmilienxD/aboard/issues/44\n";
    if (args[0] === "issue" && args[1] === "view") {
      return viewed({ number: 44, body: "- [ ] Write the first task", createdAt: "2026-07-09T00:00:00Z", state: "OPEN", labels: ["[AI]-todo"] });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  assert.equal((await github.createRoadmapTasks({ subjects: ["Write the first task"] })).issue, 44);

  const updated = await github.updateRoadmapTask({ task: 1, expect: "Write the first task", status: "completed" });
  assert.equal(updated.issue, 44);
  assert.deepEqual(gh.calls.find((args) => args[1] === "edit")?.slice(0, 3), ["issue", "edit", "44"]);
  assert.deepEqual(gh.calls.find((args) => args[1] === "view")?.slice(0, 3), ["issue", "view", "44"]);
  // The body comes from the lookup, not from what aboard wrote, so an edit the
  // user made on GitHub in between is not overwritten.
  assert.equal(gh.calls.find((args) => args[1] === "edit")?.at(-1), "- [x] Write the first task");

  // Once the index catches up the seed costs nothing: no second point lookup.
  indexed = true;
  assert.equal((await github.readRoadmap())?.number, 44);
  assert.equal(gh.calls.filter((args) => args[1] === "view").length, 1);
});

test("a minted seed never outlives the issue being a carrier", async () => {
  let carrier = { state: "OPEN", labels: ["[AI]-todo"] };
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/EmilienxD/aboard/issues/44\n";
    if (args[0] === "issue" && args[1] === "view") {
      return viewed({ number: 44, body: "- [ ] Write the first task", createdAt: "2026-07-09T00:00:00Z", ...carrier });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  await github.createRoadmapTasks({ subjects: ["Write the first task"] });

  // The user closed it: the repository has no roadmap again, and the seed must
  // not resurrect one.
  carrier = { state: "CLOSED", labels: ["[AI]-todo"] };
  assert.equal(await github.readRoadmap(), undefined);
  // Dropped, not re-checked on every later resolution.
  assert.equal(await github.readRoadmap(), undefined);
  assert.equal(gh.calls.filter((args) => args[1] === "view").length, 1);
});

test("a seeded mint re-enters the candidate set without winning it", async () => {
  let listed = "[]";
  const gh = roadmapGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return listed;
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/EmilienxD/aboard/issues/44\n";
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const github = new GitHubClient(gh);
  await github.createRoadmapTasks({ subjects: ["Minted"] });

  listed = carriers(
    { number: 44, body: "- [ ] Minted", createdAt: "2026-07-09T00:00:00Z" },
    { number: 60, body: "- [ ] Newer", createdAt: "2026-07-10T00:00:00Z" },
  );
  assert.equal((await github.readRoadmap())?.number, 60);
  assert.equal(gh.calls.some((args) => args[1] === "view"), false);
});
