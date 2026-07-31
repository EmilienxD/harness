import assert from "node:assert/strict";
import test from "node:test";

import {
  PromptResolutionError,
  PromptResolver,
  describeResolvedPrompt,
  issueDisposition,
  resolvedPromptFromText,
  type GitHubPromptSource,
  type IssueSnapshot,
  type PullRequestSnapshot,
  type ReviewThreadSnapshot,
} from "../src/claude/prompts.js";

interface FakeData {
  readonly issues?: readonly IssueSnapshot[];
  readonly pullRequests?: readonly PullRequestSnapshot[];
  readonly diff?: string;
  readonly threads?: readonly ReviewThreadSnapshot[];
}

class FakeGitHub implements GitHubPromptSource {
  public readonly issueRequests: number[] = [];

  public constructor(private readonly data: FakeData) {}

  public async getIssue(number: number): Promise<IssueSnapshot | undefined> {
    this.issueRequests.push(number);
    return (this.data.issues ?? []).find((issue) => issue.number === number);
  }

  public async getPullRequest(number: number): Promise<PullRequestSnapshot | undefined> {
    return (this.data.pullRequests ?? []).find((pull) => pull.number === number);
  }

  public async getPullRequestDiff(): Promise<string> {
    return this.data.diff ?? "";
  }

  public async listReviewThreads(): Promise<readonly ReviewThreadSnapshot[]> {
    return this.data.threads ?? [];
  }
}

const issue47: IssueSnapshot = {
  number: 47,
  title: "Add token refresh",
  body: "Refresh the access token before it expires.",
  labels: ["afk"],
  state: "open",
  parentIssueNumber: 31,
  branch: "feat/47-token-refresh",
};

const issue31: IssueSnapshot = {
  number: 31,
  title: "Auth rework",
  body: "The auth subsystem is replaced end to end.",
  labels: ["spec"],
  state: "open",
};

const pull42: PullRequestSnapshot = {
  number: 42,
  title: "Add token refresh",
  body: "Closes #47.",
  headBranch: "feat/47-token-refresh",
  baseBranch: "main",
  state: "open",
  issueNumber: 47,
};

test("resolves an implementation prompt from issue, parent spec, branch, and labels", async () => {
  const github = new FakeGitHub({ issues: [issue47, issue31] });
  const resolver = new PromptResolver({ github });

  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Keep the change small.",
    issueNumber: 47,
  });

  assert.ok(prompt !== undefined);
  assert.equal(prompt.headline, "Implement issue #47 — Add token refresh.");
  assert.match(prompt.text, /on branch `feat\/47-token-refresh`/);
  assert.match(prompt.text, /Keep the change small\./);
  assert.match(prompt.text, /## Issue #47 — Add token refresh/);
  assert.match(prompt.text, /Refresh the access token before it expires\./);
  assert.match(prompt.text, /## Parent spec #31 — Auth rework/);
  assert.match(prompt.text, /aboard will commit your change, open a pull request, and merge it/);
  assert.deepEqual(
    prompt.sources.map((source) => `${source.kind}#${source.number}`),
    ["issue#47", "parent-spec#31"],
  );
  // Everything the worker needs was fetched once, by the bridge.
  assert.deepEqual(github.issueRequests, [47, 31]);
});

test("carries the disposition each label implies", async () => {
  const cases: ReadonlyArray<readonly [readonly string[], RegExp]> = [
    [["afk"], /aboard will commit your change, open a pull request, and merge it/],
    [["hitl"], /wait for the user to review and merge it/],
    [[], /neither `afk` nor `hitl`, which is a legitimate but unresolved state/],
    [["afk", "hitl"], /wait for the user to review and merge it/],
  ];

  for (const [labels, expected] of cases) {
    const resolver = new PromptResolver({
      github: new FakeGitHub({ issues: [{ ...issue47, labels, parentIssueNumber: undefined }] }),
    });
    const prompt = await resolver.resolve({
      kind: "implementation",
      instruction: "Go.",
      issueNumber: 47,
    });
    assert.match(prompt?.text ?? "", expected, `labels ${JSON.stringify(labels)}`);
  }

  assert.equal(issueDisposition(["AFK"]), "afk");
  assert.equal(issueDisposition(["spec"]), "unclassified");
});

test("instructs the worker to create a branch when GitHub knows none", async () => {
  const resolver = new PromptResolver({
    github: new FakeGitHub({ issues: [{ ...issue47, branch: undefined }] }),
  });
  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumber: 47,
  });
  assert.match(prompt?.text ?? "", /Create or switch to a dedicated branch/);
});

test("truncates long bodies and points at the command that returns the rest", async () => {
  const resolver = new PromptResolver({
    github: new FakeGitHub({ issues: [{ ...issue47, body: "x".repeat(500) }] }),
    limits: { issueBodyChars: 100 },
  });
  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumber: 47,
  });

  assert.match(prompt?.text ?? "", /…truncated\. Read the rest with `gh issue view 47`\./);
  assert.equal(prompt?.sources[0]?.truncated, true);
});

test("resolves a review prompt with the contract and the diff", async () => {
  const resolver = new PromptResolver({
    github: new FakeGitHub({
      issues: [issue47],
      pullRequests: [pull42],
      diff: "--- a/src/auth.ts\n+++ b/src/auth.ts",
    }),
  });

  const prompt = await resolver.resolve({
    kind: "review",
    instruction: "Review against the spec.",
    pullRequestNumber: 42,
    focus: "error handling",
  });

  assert.equal(prompt?.headline, "Review pull request #42 — Add token refresh.");
  assert.match(prompt?.text ?? "", /## Requested focus\n\nerror handling/);
  assert.match(prompt?.text ?? "", /## Contract — issue #47 — Add token refresh/);
  assert.match(prompt?.text ?? "", /```diff\n--- a\/src\/auth\.ts/);
  assert.deepEqual(
    prompt?.sources.map((source) => source.kind),
    ["pull-request", "issue", "pull-request-diff"],
  );
});

test("resolves a fix prompt from unresolved threads only", async () => {
  const resolver = new PromptResolver({
    github: new FakeGitHub({
      pullRequests: [pull42],
      threads: [
        {
          id: "T1",
          path: "src/auth.ts",
          line: 12,
          isResolved: false,
          comments: [{ author: "emb", body: "This retries forever." }],
        },
        {
          id: "T2",
          path: "src/token.ts",
          line: null,
          isResolved: true,
          comments: [{ author: "emb", body: "Already handled." }],
        },
      ],
    }),
  });

  const prompt = await resolver.resolve({
    kind: "fix",
    instruction: "Address the feedback.",
    pullRequestNumber: 42,
  });

  assert.match(prompt?.text ?? "", /## Unresolved review threads \(1\)/);
  assert.match(prompt?.text ?? "", /### src\/auth\.ts:12 \(thread `T1`\)/);
  assert.equal((prompt?.text ?? "").includes("Already handled."), false);
});

test("leaves a bare brainstorm launch with no prompt at all", async () => {
  const resolver = new PromptResolver({ github: new FakeGitHub({ issues: [issue31] }) });

  assert.equal(await resolver.resolve({ kind: "brainstorm" }), undefined);

  const prompt = await resolver.resolve({
    kind: "brainstorm",
    topic: "Rework auth",
    relatedIssueNumbers: [31, 999],
  });
  assert.equal(prompt?.headline, "Brainstorm: Rework auth");
  assert.match(prompt?.text ?? "", /## Related issue #31 — Auth rework \(open\)/);
});

test("rejects an empty instruction and a missing issue or pull request", async () => {
  const resolver = new PromptResolver({ github: new FakeGitHub({}) });

  await assert.rejects(
    () => resolver.resolve({ kind: "implementation", instruction: "  ", issueNumber: 47 }),
    (error: unknown) =>
      error instanceof PromptResolutionError && error.code === "empty-instruction",
  );
  await assert.rejects(
    () => resolver.resolve({ kind: "implementation", instruction: "Go.", issueNumber: 47 }),
    (error: unknown) =>
      error instanceof PromptResolutionError && error.code === "issue-not-found",
  );
  await assert.rejects(
    () => resolver.resolve({ kind: "review", instruction: "Go.", pullRequestNumber: 42 }),
    (error: unknown) =>
      error instanceof PromptResolutionError && error.code === "pull-request-not-found",
  );
});

test("splits free-form text into a headline and body", () => {
  const prompt = resolvedPromptFromText("Look at the flake.\n\nIt fails on Windows only.");
  assert.equal(prompt.headline, "Look at the flake.");
  assert.equal(prompt.body, "It fails on Windows only.");
  assert.deepEqual(prompt.sources, []);
});

test("summarizes a prompt without repeating its content", async () => {
  const resolver = new PromptResolver({
    github: new FakeGitHub({ issues: [{ ...issue47, body: "The API key is hunter2." }] }),
  });
  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumber: 47,
  });

  const description = describeResolvedPrompt(prompt);
  assert.equal(description.includes("hunter2"), false);
  assert.match(description, /^prompt=\d+ chars sources=issue#47\(\d+\)$/);
  assert.equal(describeResolvedPrompt(undefined), "prompt=none");
});

test("interactive launches resolve to no prompt so the terminal opens empty", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github: new FakeGitHub({}) }));
  for (const type of ["brainstormer", "raw"] as const) {
    assert.equal(await adapter.resolve({ type, description: "d" }), undefined);
    assert.equal(await adapter.resolve({ type, description: "d", prompt: "   " }), undefined);
    // A Manager delegating with a real topic still gets it; only filler is gone.
    const withTopic = await adapter.resolve({ type, description: "d", prompt: "caching layer" });
    assert.equal(withTopic?.text.includes("caching layer"), true);
  }
  // Automated types keep their fallback: a worker with no first message would
  // sit at an empty TUI forever.
  const doctor = await adapter.resolve({ type: "pr-doctor-afk", description: "d" });
  assert.match(String(doctor?.text), /Review the supplied change against its contract\./);
});
