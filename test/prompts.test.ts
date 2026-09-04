import assert from "node:assert/strict";
import test from "node:test";

import {
  PromptResolutionError,
  PromptResolver,
  describeResolvedPrompt,
  normalizeGeneratedPrompt,
  resolvedPromptFromText,
  type GitHubPromptSource,
  type IssueSnapshot,
  type PullRequestSnapshot,
} from "../src/claude/prompts.js";
import { issueDifficulty, issueDisposition } from "../src/shared/labels.js";

interface FakeData {
  readonly issues?: readonly IssueSnapshot[];
  readonly pullRequests?: readonly PullRequestSnapshot[];
  readonly diff?: string;
}

class FakeGitHub implements GitHubPromptSource {
  public readonly issueRequests: number[] = [];
  public diffRequests = 0;

  public constructor(private readonly data: FakeData) {}

  public async getIssue(number: number): Promise<IssueSnapshot | undefined> {
    this.issueRequests.push(number);
    return (this.data.issues ?? []).find((issue) => issue.number === number);
  }

  public async getPullRequest(number: number): Promise<PullRequestSnapshot | undefined> {
    return (this.data.pullRequests ?? []).find((pull) => pull.number === number);
  }

  public async getPullRequestDiff(): Promise<string> {
    this.diffRequests += 1;
    return this.data.diff ?? "";
  }

}

const issue47: IssueSnapshot = {
  number: 47,
  title: "Add token refresh",
  body: "Refresh the access token before it expires.",
  labels: ["[AI]-afk"],
  state: "open",
  comments: [],
  parentIssueNumber: 31,
};

const parent31: IssueSnapshot = {
  number: 31,
  title: "Auth rework",
  body: "The auth subsystem is replaced end to end.",
  labels: ["planning"],
  state: "open",
  comments: [],
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

test("normalizes slash-prefixed words in generated prompts", () => {
  const normalized = normalizeGeneratedPrompt(resolvedPromptFromText(
    "/review //carefully keep mid/word and https://example.com.\nThen /done; leave / alone.",
  ));

  assert.equal(
    normalized.text,
    "review carefully keep mid/word and https://example.com.\nThen done; leave / alone.",
  );
  assert.equal(normalized.headline, "review carefully keep mid/word and https://example.com.");
  assert.equal(normalized.body, "Then done; leave / alone.");
});

test("resolves an implementation prompt from issue and parent issue", async () => {
  const github = new FakeGitHub({ issues: [issue47, parent31] });
  const resolver = new PromptResolver({ github });

  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Keep the change small.",
    issueNumbers: [47],
  });

  assert.ok(prompt !== undefined);
  // Caller-supplied input survives verbatim; the resolved wording around it is
  // free to change without touching this test.
  assert.ok(prompt.text.includes("#47"));
  assert.ok(prompt.text.includes("Add token refresh"));
  assert.ok(prompt.text.includes("Keep the change small."));
  assert.ok(prompt.text.includes("Refresh the access token before it expires."));
  assert.deepEqual(
    prompt.sources.map((source) => `${source.kind}#${source.number}`),
    ["issue#47", "parent-issue#31"],
  );
  // Everything the worker needs was fetched once, by the bridge.
  assert.deepEqual(github.issueRequests, [47, 31]);
});

test("implementation prompts omit disposition guidance regardless of issue labels", async () => {
  const prompts = [];
  for (const labels of [[], ["[AI]-afk"], ["[AI]-hitl"], ["[AI]-afk", "[AI]-hitl"]]) {
    const resolver = new PromptResolver({
      github: new FakeGitHub({ issues: [{ ...issue47, labels }, parent31] }),
    });
    const prompt = await resolver.resolve({
      kind: "implementation",
      instruction: "Keep the change small.",
      issueNumbers: [47],
    });
    assert.ok(prompt !== undefined);
    prompts.push(prompt);
  }
  for (const prompt of prompts) assert.deepEqual(prompt, prompts[0]);
});

test("classifies the disposition each label implies", () => {
  assert.equal(issueDisposition(["[AI]-afk"]), "afk");
  assert.equal(issueDisposition(["[AI]-hitl"]), "hitl");
  assert.equal(issueDisposition([]), "unclassified");
  // A contradictory pair resolves to hitl: only a human may close one.
  assert.equal(issueDisposition(["[AI]-afk", "[AI]-hitl"]), "hitl");
  assert.equal(issueDisposition(["[ai]-AFK"]), "afk");
  assert.equal(issueDisposition(["planning"]), "unclassified");
  // The former prefix has no compatibility path: those labels are ordinary
  // user labels now, just like the unprefixed spellings.
  assert.equal(issueDisposition(["ai:afk", "ai:hitl", "AI:AFK"]), "unclassified");
  // The unprefixed names are the user's own labels, never aboard's.
  assert.equal(issueDisposition(["afk", "hitl"]), "unclassified");
});

test("carries the difficulty each label implies", () => {
  assert.equal(issueDifficulty(["[AI]-routine-difficulty"]), "routine");
  assert.equal(issueDifficulty(["[AI]-basic-difficulty"]), "basic");
  assert.equal(issueDifficulty(["[AI]-advanced-difficulty"]), "advanced");
  assert.equal(issueDifficulty(["[AI]-expert-difficulty"]), "expert");
  assert.equal(issueDifficulty(["[ai]-EXPERT-Difficulty"]), "expert");
  // Unrated is not a guess and not an error; the caller resolves it to a tier.
  assert.equal(issueDifficulty([]), undefined);
  assert.equal(issueDifficulty(["[AI]-afk", "planning"]), undefined);
  // The unprefixed names are the user's own labels, never aboard's.
  assert.equal(issueDifficulty(["expert", "expert-difficulty"]), undefined);
  // A contradictory set resolves upward, whatever order it arrives in.
  assert.equal(issueDifficulty(["[AI]-routine-difficulty", "[AI]-advanced-difficulty"]), "advanced");
  assert.equal(issueDifficulty(["[AI]-expert-difficulty", "[AI]-basic-difficulty"]), "expert");
});

test("preserves complete primary, parent, and related issue bodies", async () => {
  const bodies = ["primary", "parent", "related"].map((label) => `${label}\n${"x".repeat(25_000)}\n${label} end`);
  const resolver = new PromptResolver({
    github: new FakeGitHub({ issues: [
      { ...issue47, body: bodies[0]!, dependencyIssueNumbers: [52] },
      { ...parent31, body: bodies[1]! },
      { ...issue47, number: 52, body: bodies[2]! },
    ] }),
  });
  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumbers: [47],
  });

  assert.ok(prompt);
  for (const body of bodies) assert.ok(prompt.text.includes(body));
  assert.deepEqual(prompt.sources.map((source) => source.chars), bodies.map((body) => body.length));
  assert.doesNotMatch(prompt.text, /truncated/);
});

test("renders issue comments with each implementation issue document", async () => {
  const resolver = new PromptResolver({
    github: new FakeGitHub({ issues: [
      {
        ...issue47,
        comments: [{ authorLogin: "maintainer", body: "Use a five-minute refresh window." }],
        dependencyIssueNumbers: [52],
      },
      {
        ...parent31,
        comments: [{ authorLogin: "architect", body: "Keep refresh state per account." }],
      },
      {
        ...issue47,
        number: 52,
        title: "Related contract",
        comments: [{ body: "The original author was deleted." }],
      },
    ] }),
  });

  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumbers: [47],
  });

  assert.ok(prompt?.text.includes("#### @maintainer\n\nUse a five-minute refresh window."));
  assert.ok(prompt?.text.includes("#### @architect\n\nKeep refresh state per account."));
  assert.ok(prompt?.text.includes("#### @ghost\n\nThe original author was deleted."));
});

test("injects fresh Explore context once and omits generated context comments", async () => {
  const report = "Use src/auth/refresh.ts and preserve per-account state.";
  const generated = `<!-- aboard:auto-run-exploration run=run_test issue=47 head=${"a".repeat(40)} -->\n\n## Aboard codebase context\n\n${report}`;
  const prompt = await new PromptResolver({
    github: new FakeGitHub({ issues: [{
      ...issue47,
      parentIssueNumber: undefined,
      comments: [
        { authorLogin: "maintainer", body: "Keep the timeout configurable." },
        { authorLogin: "maintainer", body: generated },
      ],
    }] }),
  }).resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumbers: [47],
    codebaseContext: report,
  });

  assert.match(prompt?.text ?? "", /## Fresh codebase context/);
  assert.match(prompt?.text ?? "", /Keep the timeout configurable/);
  assert.doesNotMatch(prompt?.text ?? "", /aboard:auto-run-exploration/);
  assert.equal((prompt?.text.match(/Use src\/auth\/refresh\.ts/g) ?? []).length, 1);
});

test("caps each issue at its newest comments and marks omitted discussion", async () => {
  const comments = Array.from({ length: 5 }, (_, index) => ({
    authorLogin: `author-${index + 1}`,
    body: `Comment ${index + 1}`,
  }));
  const prompt = await new PromptResolver({
    github: new FakeGitHub({ issues: [{ ...issue47, comments }] }),
    limits: { issueCommentCount: 2 },
  }).resolve({ kind: "implementation", instruction: "Go.", issueNumbers: [47] });

  assert.doesNotMatch(prompt?.text ?? "", /Comment [123]/);
  assert.match(prompt?.text ?? "", /3 older comments were omitted; showing the newest 2/);
  assert.ok(prompt?.text.includes("Comment 4"));
  assert.ok(prompt?.text.includes("Comment 5"));
  assert.ok((prompt?.text.indexOf("Comment 4") ?? -1) < (prompt?.text.indexOf("Comment 5") ?? -1));
});

test("a global review budget stops only after a complete issue, description, or diff", async () => {
  const body = `Contract\n${"x".repeat(25_000)}\nFinal requirement.`;
  const description = `Description\n${"y".repeat(25_000)}\nDescription end.`;
  const diff = `--- a/file\n+++ b/file\n+${"z".repeat(45_000)}\n+final change`;
  const data = { issues: [{ ...issue47, body }], pullRequests: [{ ...pull42, body: description }], diff };
  const request = { kind: "review", instruction: "Review.", pullRequestNumber: 42 } as const;
  const full = await new PromptResolver({
    github: new FakeGitHub(data), limits: { maxPromptChars: 200_000 },
  }).resolve(request);
  assert.ok(full);
  const issueEnd = full.text.indexOf(body) + body.length;
  const descriptionEnd = full.text.indexOf(description) + description.length;

  for (const [maxPromptChars, end, count] of [
    [1, issueEnd, 1],
    [1_000, issueEnd, 1],
    [issueEnd, issueEnd, 1],
    [issueEnd + 1, descriptionEnd, 2],
    [descriptionEnd - 1, descriptionEnd, 2],
    [descriptionEnd, descriptionEnd, 2],
    [descriptionEnd + 1, full.text.length, 3],
    [full.text.length - 1, full.text.length, 3],
    [full.text.length + 1, full.text.length, 3],
  ] as const) {
    const github = new FakeGitHub(data);
    const prompt = await new PromptResolver({ github, limits: { maxPromptChars } }).resolve(request);
    assert.ok(prompt);
    assert.equal(prompt.text, full.text.slice(0, end), `budget ${maxPromptChars}`);
    assert.deepEqual(prompt.sources.map((source) => source.kind), ["issue", "pull-request", "pull-request-diff"].slice(0, count));
    assert.equal(github.diffRequests, count === 3 ? 1 : 0);
  }
});

test("the global budget counts headings and instructions and stops related issue traversal", async () => {
  const request = { kind: "implementation", instruction: "Go.", issueNumbers: [47] } as const;
  const primary = await new PromptResolver({ github: new FakeGitHub({ issues: [issue47] }) }).resolve(request);
  assert.ok(primary);
  const github = new FakeGitHub({ issues: [issue47, parent31] });
  const prompt = await new PromptResolver({
    github, limits: { maxPromptChars: primary.text.length },
  }).resolve(request);
  assert.equal(prompt?.text, primary.text);
  assert.deepEqual(github.issueRequests, [47]);
});

test("a document crossing the budget is complete and later primary issues are omitted", async () => {
  const body = `${"x".repeat(500)}\nFinal requirement.`;
  const comment = "The final discussion remains part of the complete issue document.";
  const prompt = await new PromptResolver({
    github: new FakeGitHub({ issues: [{
      ...issue47,
      body,
      comments: [{ authorLogin: "maintainer", body: comment }],
    }, parent31] }),
    limits: { maxPromptChars: 100 },
  }).resolve({ kind: "implementation", instruction: "Go.", issueNumbers: [47, 31] });
  assert.ok(prompt?.text.includes(body));
  assert.ok(prompt?.text.includes(comment));
  assert.equal(prompt?.text.includes(parent31.body), false);
  assert.deepEqual(prompt?.sources.map((source) => source.number), [47]);
});

test("brainstorm context preserves complete issue bodies", async () => {
  const body = `Context\n${"x".repeat(25_000)}\nFinal requirement.`;
  const comment = "Later discussion narrows the context.";
  const prompt = await new PromptResolver({
    github: new FakeGitHub({ issues: [{
      ...issue47,
      body,
      comments: [{ authorLogin: "maintainer", body: comment }],
    }, parent31] }),
    limits: { maxPromptChars: 100 },
  }).resolve({ kind: "brainstorm", relatedIssueNumbers: [47, 31] });

  assert.ok(prompt);
  assert.ok(prompt.text.includes(body));
  assert.ok(prompt.text.includes(comment));
  assert.deepEqual(prompt.sources.map((source) => source.number), [47]);
  assert.equal(prompt.text.includes(parent31.body), false);
});

test("resolves a review prompt with the contract and the diff", async () => {
  const resolver = new PromptResolver({
    github: new FakeGitHub({
      issues: [{
        ...issue47,
        comments: [{ authorLogin: "reviewer", body: "The timeout must remain configurable." }],
      }],
      pullRequests: [pull42],
      diff: "--- a/src/auth.ts\n+++ b/src/auth.ts",
    }),
  });

  const prompt = await resolver.resolve({
    kind: "review",
    instruction: "Review against the issue contract.",
    pullRequestNumber: 42,
    focus: "error handling",
  });

  // Caller-supplied material survives verbatim.
  assert.ok(prompt?.text.includes("#42"));
  assert.ok(prompt?.text.includes("Add token refresh"));
  assert.ok(prompt?.text.includes("error handling"));
  assert.ok(prompt?.text.includes("#### @reviewer\n\nThe timeout must remain configurable."));
  assert.ok(prompt?.text.includes("--- a/src/auth.ts"));
  assert.deepEqual(
    prompt?.sources.map((source) => source.kind),
    ["issue", "pull-request", "pull-request-diff"],
  );
});

test("leaves a bare brainstorm launch with no prompt at all", async () => {
  const resolver = new PromptResolver({ github: new FakeGitHub({ issues: [parent31] }) });

  assert.equal(await resolver.resolve({ kind: "brainstorm" }), undefined);

  const prompt = await resolver.resolve({
    kind: "brainstorm",
    topic: "Rework auth",
    relatedIssueNumbers: [31, 999],
  });
  assert.ok(prompt?.text.includes("Rework auth"));
  // Resolvable related issues contribute their content; missing ones are dropped.
  assert.ok(prompt?.text.includes("The auth subsystem is replaced end to end."));
  assert.equal(prompt?.text.includes("999"), false);
});

test("rejects an empty instruction and a missing issue or pull request", async () => {
  const resolver = new PromptResolver({ github: new FakeGitHub({}) });

  await assert.rejects(
    () => resolver.resolve({ kind: "implementation", instruction: "  ", issueNumbers: [47] }),
    (error: unknown) =>
      error instanceof PromptResolutionError && error.code === "empty-instruction",
  );
  await assert.rejects(
    () => resolver.resolve({ kind: "implementation", instruction: "Go.", issueNumbers: [47] }),
    (error: unknown) =>
      error instanceof PromptResolutionError && error.code === "issue-not-found",
  );
  await assert.rejects(
    () => resolver.resolve({ kind: "review", instruction: "Go.", pullRequestNumber: 42 }),
    (error: unknown) =>
      error instanceof PromptResolutionError && error.code === "pull-request-not-found",
  );
});

test("recursive issue context terminates across parent and reference cycles", async () => {
  const issue52: IssueSnapshot = {
    number: 52,
    title: "Cache the token",
    body: "Uses the auth contract.",
    labels: ["[AI]-afk"],
    state: "open",
    comments: [],
    dependencyIssueNumbers: [31],
  };
  const github = new FakeGitHub({
    issues: [
      { ...issue47, dependencyIssueNumbers: [31] },
      { ...parent31, dependencyIssueNumbers: [47, 52] },
      issue52,
    ],
  });
  const prompt = await new PromptResolver({ github }).resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumbers: [47],
  });

  assert.deepEqual(github.issueRequests, [47, 31, 52]);
  assert.deepEqual(
    prompt?.sources.map((source) => `${source.kind}#${source.number}`),
    ["issue#47", "parent-issue#31", "related-issue#52"],
  );
});

test("implementation context can stop after the primary issue's direct references", async () => {
  const issue52: IssueSnapshot = {
    number: 52,
    title: "Cache the token",
    body: "Only the recursively referenced body.",
    labels: ["[AI]-afk"],
    state: "open",
    comments: [],
  };
  const github = new FakeGitHub({
    issues: [
      { ...issue47, dependencyIssueNumbers: [31] },
      { ...parent31, dependencyIssueNumbers: [52] },
      issue52,
    ],
  });
  const prompt = await new PromptResolver({ github }).resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumbers: [47],
    recursiveIssueReferences: false,
  });

  assert.deepEqual(github.issueRequests, [47, 31]);
  assert.deepEqual(
    prompt?.sources.map((source) => `${source.kind}#${source.number}`),
    ["issue#47", "parent-issue#31"],
  );
  assert.equal(prompt?.text.includes(issue52.body), false);
});

test("recursive issue context has a hard node bound even without a cycle", async () => {
  const issues = Array.from({ length: 10 }, (_, index): IssueSnapshot => ({
    number: index + 1,
    title: `Linked ${index + 1}`,
    body: `Body ${index + 1}`,
    labels: ["[AI]-afk"],
    state: "open",
    comments: [],
    dependencyIssueNumbers: index === 9 ? [] : [index + 2],
  }));
  const github = new FakeGitHub({ issues });
  const prompt = await new PromptResolver({ github, limits: { relatedIssueCount: 3 } }).resolve({
    kind: "implementation",
    instruction: "Go.",
    issueNumbers: [1],
  });

  assert.deepEqual(github.issueRequests, [1, 2, 3, 4]);
  assert.equal(prompt?.sources.length, 4);
});

test("an issue-bound prompt with no issues is rejected", async () => {
  const resolver = new PromptResolver({ github: new FakeGitHub({ issues: [issue47, parent31] }) });
  // An issue-bound prompt with nothing to bind to is a typed refusal, not an
  // empty section list.
  await assert.rejects(
    () => resolver.resolve({ kind: "implementation", instruction: "Go.", issueNumbers: [] }),
    (error: unknown) => error instanceof PromptResolutionError && error.code === "no-issue",
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
    issueNumbers: [47],
  });

  const description = describeResolvedPrompt(prompt);
  assert.equal(description.includes("hunter2"), false);
  assert.match(description, /^prompt=\d+ chars sources=issue#47\(\d+\)$/);
  assert.equal(describeResolvedPrompt(undefined), "prompt=none");
});

test("delegated prompts remain free-form and fetch no GitHub context", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({
    github: new FakeGitHub({ issues: [issue47, parent31] }),
  }));
  const prompt = await adapter.resolve({
    type: "general-purpose",
    description: "fix the session loss",
    prompt: "Work with me to fix issue #47.",
  }, { interactive: true });

  assert.ok(prompt?.text.includes("Work with me to fix issue #47."));
  assert.deepEqual(prompt?.sources, []);
  assert.equal(await adapter.resolve({ type: "general-purpose", description: "d" }, { interactive: true }), undefined);
  const brainstorm = await adapter.resolve({
    type: "brainstormer", description: "d", prompt: "caching layer",
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
  const doctor = await adapter.resolve({ type: "pr-doctor-afk", description: "d" }, { interactive: false });
  assert.notEqual(doctor, undefined);
  assert.ok(doctor!.text.length > 0);
});

test("auto-agent guidance is the final section after resolved issue and pull-request context", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({
    github: new FakeGitHub({
      issues: [issue47, parent31],
      pullRequests: [{ ...pull42, headBranch: "abd/47-token-refresh", baseBranch: "abd/run/test" }],
      diff: "+ refreshEarly();",
    }),
  }));
  const permanentPrompt = "run the full browser suite";
  const guideline = "no unit tests needed";
  // The resolved text ends with the caller's guideline, verbatim; the heading
  // above it is prose and free to change.

  const implementer = await adapter.resolve({
    type: "implementer",
    description: "address issue 47",
    issues: [47],
    permanentPrompt,
    additionalGuideline: guideline,
  }, { interactive: false });
  const implementerText = implementer?.text ?? "";
  assert.doesNotMatch(implementerText, /aboard|auto[ -]?run|automated|automation/i);
  assert.equal(implementerText.trimEnd().endsWith(guideline), true);
  // The resolved issue context comes first.
  assert.equal(implementerText.indexOf("Refresh the access token before it expires.") < implementerText.indexOf(guideline), true);
  assert.equal(implementerText.indexOf(permanentPrompt) < implementerText.indexOf(guideline), true);

  for (const type of ["pr-doctor-afk", "pr-doctor-hitl"] as const) {
    const doctor = await adapter.resolve({
      type,
      description: "review pull request 42",
      pullRequest: 42,
      permanentPrompt,
      additionalGuideline: guideline,
    }, { interactive: type === "pr-doctor-hitl" });
    const doctorText = doctor?.text ?? "";
    assert.doesNotMatch(doctorText, /aboard|auto[ -]?run|automated|automation/i);
    assert.equal(doctorText.trimEnd().endsWith(guideline), true, type);
    // The resolved diff comes first.
    assert.equal(doctorText.indexOf("+ refreshEarly();") < doctorText.indexOf(guideline), true, type);
    assert.equal(doctorText.indexOf(permanentPrompt) < doctorText.indexOf(guideline), true, type);
  }
});

test("a builtin type's prompt follows its launch mode, not its type", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github: new FakeGitHub({}) }));
  // Interactive: the terminal opens empty even though the type can also run
  // unattended; the user types the first message.
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

test("an issue-bound Explore launch receives resolved issue context", async () => {
  const { GitHubDelegationPromptResolver } = await import("../src/github/prompt-adapter.js");
  const github = new FakeGitHub({ issues: [issue47, parent31] });
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github }));

  const prompt = await adapter.resolve({
    type: "Explore",
    description: "explore issue 47",
    issues: [47],
    prompt: "Map relevant files and tests.",
  }, { interactive: false });

  assert.match(prompt?.text ?? "", /Explore implementation context for issue #47/);
  assert.match(prompt?.text ?? "", /Refresh the access token before it expires/);
  assert.match(prompt?.text ?? "", /The auth subsystem is replaced end to end/);
  assert.deepEqual(github.issueRequests, [47, 31]);
});
