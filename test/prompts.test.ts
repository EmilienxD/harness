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
  labels: ["ai:afk"],
  state: "open",
  parentIssueNumber: 31,
  branch: "feat/47-token-refresh",
};

const issue31: IssueSnapshot = {
  number: 31,
  title: "Auth rework",
  body: "The auth subsystem is replaced end to end.",
  labels: ["ai:spec"],
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
  // Caller-supplied input survives verbatim; the resolved wording around it is
  // free to change without touching this test.
  assert.ok(prompt.text.includes("Keep the change small."));
  assert.ok(prompt.text.includes("Refresh the access token before it expires."));
  assert.deepEqual(
    prompt.sources.map((source) => `${source.kind}#${source.number}`),
    ["issue#47", "parent-spec#31"],
  );
  // Everything the worker needs was fetched once, by the bridge.
  assert.deepEqual(github.issueRequests, [47, 31]);
});

test("carries the disposition each label implies", () => {
  // The mapping is data, tested at the data level; the prose each disposition
  // resolves into is free to change.
  assert.equal(issueDisposition(["ai:afk"]), "afk");
  assert.equal(issueDisposition(["ai:hitl"]), "hitl");
  assert.equal(issueDisposition([]), "unclassified");
  // A contradictory pair resolves to hitl: only a human may close one.
  assert.equal(issueDisposition(["ai:afk", "ai:hitl"]), "hitl");
  assert.equal(issueDisposition(["AI:AFK"]), "afk");
  assert.equal(issueDisposition(["ai:spec"]), "unclassified");
  // The unprefixed names are the user's own labels, never aboard's.
  assert.equal(issueDisposition(["afk", "hitl"]), "unclassified");
});

test("the prompt differs when GitHub knows no branch for the issue", async () => {
  const resolve = (branch: string | undefined) =>
    new PromptResolver({
      github: new FakeGitHub({ issues: [{ ...issue47, branch, parentIssueNumber: undefined }] }),
    }).resolve({ kind: "implementation", instruction: "Go.", issueNumber: 47 });
  const withBranch = await resolve("feat/47-token-refresh");
  const withoutBranch = await resolve(undefined);
  assert.notEqual(withoutBranch?.text, withBranch?.text);
});

test("truncates long bodies and marks the source truncated", async () => {
  const resolver = new PromptResolver({
    github: new FakeGitHub({ issues: [{ ...issue47, body: "x".repeat(500) }] }),
    limits: { issueBodyChars: 100 },
  });
  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumber: 47,
  });

  assert.equal(prompt?.sources[0]?.truncated, true);
  assert.equal(prompt?.text.includes("x".repeat(500)), false);
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
  // Caller-supplied material survives verbatim.
  assert.ok(prompt?.text.includes("error handling"));
  assert.ok(prompt?.text.includes("--- a/src/auth.ts"));
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

  // The unresolved thread's content is in; the resolved thread's is out.
  assert.ok(prompt?.text.includes("This retries forever."));
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
  // Resolvable related issues contribute their content; missing ones are dropped.
  assert.ok(prompt?.text.includes("The auth subsystem is replaced end to end."));
  assert.equal(prompt?.text.includes("999"), false);
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

test("an issue-bound webresearcher receives resolved issue and parent-spec context", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({
    github: new FakeGitHub({ issues: [issue47, issue31] }),
  }));
  const prompt = await adapter.resolve({
    type: "webresearcher",
    description: "research current auth guidance",
    prompt: "Verify whether the proposed token lifetime matches current guidance.",
    issue: 47,
  }, { interactive: false });

  assert.ok(prompt?.text.includes("Verify whether the proposed token lifetime matches current guidance."));
  assert.deepEqual(prompt?.sources.map((source) => [source.kind, source.number]), [
    ["issue", 47],
    ["parent-spec", 31],
  ]);
});

test("an issue-bound Explore receives resolved issue context with its instruction", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({
    github: new FakeGitHub({ issues: [issue47, issue31] }),
  }));
  const prompt = await adapter.resolve({
    type: "Explore",
    description: "check backlog handling",
    prompt: "Investigate whether the backlog is handled elsewhere.",
    issue: 47,
  }, { interactive: false });

  assert.ok(prompt?.text.includes("Investigate whether the backlog is handled elsewhere."));
  assert.deepEqual(prompt?.sources.map((source) => source.kind), ["issue", "parent-spec"]);
});

test("an issue-bound interactive general-purpose opens with the resolved contract, not an empty topic", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({
    github: new FakeGitHub({ issues: [issue47, issue31] }),
  }));
  const prompt = await adapter.resolve({
    type: "general-purpose",
    description: "fix the session loss",
    prompt: "Work with me to fix the session loss.",
    issue: 47,
  }, { interactive: true });

  assert.ok(prompt?.text.includes("Work with me to fix the session loss."));
  assert.deepEqual(prompt?.sources.map((source) => source.kind), ["issue", "parent-spec"]);
  // Without an opening topic an interactive terminal opens empty; the issue
  // number alone is not a first message.
  assert.equal(await adapter.resolve({ type: "general-purpose", description: "d", issue: 47 }, { interactive: true }), undefined);
  // Interactive-only types keep the free-form topic: their conversation
  // defines its own scope, and the bridge does not silently widen it.
  const brainstorm = await adapter.resolve({
    type: "brainstormer", description: "d", prompt: "caching layer", issue: 47,
  }, { interactive: true });
  assert.ok(brainstorm?.text.includes("caching layer"));
  // Free-form topics fetch nothing: no GitHub sources are attached.
  assert.deepEqual(brainstorm?.sources, []);
});

test("interactive launches resolve to no prompt so the terminal opens empty", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github: new FakeGitHub({}) }));
  for (const type of ["brainstormer"] as const) {
    assert.equal(await adapter.resolve({ type, description: "d" }, { interactive: true }), undefined);
    assert.equal(await adapter.resolve({ type, description: "d", prompt: "   " }, { interactive: true }), undefined);
    // A Manager delegating with a real topic still gets it; only filler is gone.
    const withTopic = await adapter.resolve({ type, description: "d", prompt: "caching layer" }, { interactive: true });
    assert.equal(withTopic?.text.includes("caching layer"), true);
  }
  // Automated types fall back to a default instruction: a worker with no first
  // message would sit at an empty TUI forever. The fallback's wording is free
  // to change; what matters is that a launchable prompt exists.
  const doctor = await adapter.resolve({ type: "pr-doctor-afk", description: "d" }, { interactive: false });
  assert.notEqual(doctor, undefined);
  assert.ok(doctor!.text.length > 0);
});

test("a builtin type's prompt follows its launch mode, not its type", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github: new FakeGitHub({}) }));
  // Interactive: the terminal opens empty even though the type can also run
  // unattended — the user types the first message.
  assert.equal(await adapter.resolve({ type: "general-purpose", description: "d" }, { interactive: true }), undefined);
  assert.equal(await adapter.resolve({ type: "Explore", description: "d" }, { interactive: true }), undefined);
  const topic = await adapter.resolve({ type: "Explore", description: "d", prompt: "auth flow" }, { interactive: true });
  assert.equal(topic?.text.includes("auth flow"), true);
  // Automated: the prompt is the first user turn, and a missing one still falls
  // back rather than leave an agent at an empty terminal.
  const task = await adapter.resolve({ type: "general-purpose", description: "d", prompt: "find the retry bug" }, { interactive: false });
  assert.equal(task?.text.includes("find the retry bug"), true);
  const fallback = await adapter.resolve({ type: "Explore", description: "d" }, { interactive: false });
  assert.notEqual(fallback, undefined);
  assert.ok(fallback!.text.length > 0);
});
