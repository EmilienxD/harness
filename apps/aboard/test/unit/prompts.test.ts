import assert from "node:assert/strict";
import test from "node:test";

import {
  PromptResolutionError,
  PromptResolver,
  describeResolvedPrompt,
  type GitHubPromptSource,
  type IssueSnapshot,
  type PullRequestSnapshot,
} from "../../src/claude/prompts.js";
import { issueDifficulty, issueDisposition } from "../../src/shared/labels.js";

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

test("resolves an implementation prompt from issue and parent issue", async () => {
  const github = new FakeGitHub({ issues: [issue47, parent31] });
  const resolver = new PromptResolver({ github });

  const prompt = await resolver.resolve({
    kind: "implementation",
    instruction: "Keep the change small.",
    issueNumbers: [47],
  });

  assert.ok(prompt !== undefined);
  // Verify that issue context is included
  assert.ok(prompt.text.includes('number="47"'));
  assert.ok(prompt.text.includes("Add token refresh"));
  assert.ok(prompt.text.includes("Refresh the access token before it expires."));
  assert.deepEqual(
    prompt.sources.map((source) => `${source.kind}#${source.number}`),
    ["issue#47", "parent-issue#31"],
  );
  // Everything the worker needs was fetched once, by the bridge.
  assert.deepEqual(github.issueRequests, [47, 31]);
});

test("separates implementation targets from supporting context with HTML sections", async () => {
  const prompt = await new PromptResolver({
    github: new FakeGitHub({
      issues: [
        {
          ...issue47,
          comments: [{ authorLogin: "maintainer", body: "Preserve the current retry policy." }],
        },
        parent31,
      ],
    }),
  }).resolve({
    kind: "implementation",
    instruction: "Keep the change small.",
    issueNumbers: [47],
  });

  assert.ok(prompt, "prompt should be resolved");
  const targetStart = prompt.text.indexOf("<work-to-address>");
  const targetEnd = prompt.text.indexOf("</work-to-address>");
  const contextStart = prompt.text.indexOf("<context>");
  const contextEnd = prompt.text.indexOf("</context>");
  const issueBody = prompt.text.indexOf(issue47.body);
  const comment = prompt.text.indexOf("Preserve the current retry policy.");
  const parentBody = prompt.text.indexOf(parent31.body);

  assert.ok(prompt.text.indexOf("Keep the change small.") < targetStart);
  assert.ok(targetStart < issueBody && issueBody < targetEnd);
  assert.ok(targetEnd < contextStart);
  assert.ok(contextStart < comment && comment < contextEnd);
  assert.ok(contextStart < parentBody && parentBody < contextEnd);
  assert.doesNotMatch(prompt.text, /^#{1,6} /mu);
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

  assert.ok(prompt?.text.includes('<comment author="@maintainer">\nUse a five-minute refresh window.'));
  assert.ok(prompt?.text.includes('<comment author="@architect">\nKeep refresh state per account.'));
  assert.ok(prompt?.text.includes('<comment author="@ghost">\nThe original author was deleted.'));
});

test("injects fresh Explore context once and omits generated context comments", async () => {
  const report = "Use src/auth/refresh.ts and preserve per-account state.";
  const generated = `## Codebase context\n\n_Generated from \`${"a".repeat(12)}\` and its current working tree immediately before implementation._\n\n${report}`;
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

  assert.ok(prompt, "prompt should be resolved");
  assert.match(prompt.text, /Keep the timeout configurable/);
  assert.equal((prompt.text.match(/Use src\/auth\/refresh\.ts/g) ?? []).length, 1);
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

  assert.ok(prompt, "prompt should be resolved");
  assert.ok(prompt.text.includes("Comment 4"));
  assert.ok(prompt.text.includes("Comment 5"));
  assert.ok((prompt.text.indexOf("Comment 4") ?? -1) < (prompt.text.indexOf("Comment 5") ?? -1));
});

test("a global review budget stops only after a complete HTML-delimited source", async () => {
  const body = `Contract\n${"x".repeat(25_000)}\nFinal requirement.`;
  const description = `Description\n${"y".repeat(25_000)}\nDescription end.`;
  const diff = `--- a/file\n+++ b/file\n+${"z".repeat(45_000)}\n+final change`;
  const data = { issues: [{ ...issue47, body }], pullRequests: [{ ...pull42, body: description }], diff };
  const request = { kind: "review", instruction: "Review.", pullRequestNumber: 42 } as const;
  const full = await new PromptResolver({
    github: new FakeGitHub(data), limits: { maxPromptChars: 200_000 },
  }).resolve(request);
  assert.ok(full);
  for (const [maxPromptChars, count] of [
    [1, 1],
    [30_000, 2],
    [200_000, 3],
  ] as const) {
    const github = new FakeGitHub(data);
    const prompt = await new PromptResolver({ github, limits: { maxPromptChars } }).resolve(request);
    assert.ok(prompt);
    assert.deepEqual(prompt.sources.map((source) => source.kind), ["issue", "pull-request", "pull-request-diff"].slice(0, count));
    assert.ok(prompt.text.includes(body));
    assert.equal(prompt.text.includes(description), count >= 2);
    assert.equal(prompt.text.includes(diff), count >= 3);
    assert.match(prompt.text, /<work-to-review>[\s\S]*<\/work-to-review>/u);
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
    }, {
      ...parent31,
      comments: [{ authorLogin: "architect", body: "This omitted issue comment must stay omitted." }],
    }] }),
    limits: { maxPromptChars: 100 },
  }).resolve({ kind: "implementation", instruction: "Go.", issueNumbers: [47, 31] });
  assert.ok(prompt?.text.includes(body));
  assert.ok(prompt?.text.includes(comment));
  assert.equal(prompt?.text.includes(parent31.body), false);
  assert.equal(prompt?.text.includes("This omitted issue comment must stay omitted."), false);
  assert.deepEqual(prompt?.sources.map((source) => source.number), [47]);
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
  });

  assert.ok(prompt, "prompt should be resolved");
  assert.ok(prompt.text.includes('number="42"'));
  assert.ok(prompt.text.includes("Add token refresh"));
  assert.ok(prompt.text.includes('<comment author="@reviewer">\nThe timeout must remain configurable.'));
  assert.ok(prompt.text.includes("--- a/src/auth.ts"));
  const workEnd = prompt.text.indexOf("</work-to-review>");
  const contextStart = prompt.text.indexOf("<context>");
  assert.ok(prompt.text.indexOf(issue47.body) < workEnd);
  assert.ok(prompt.text.indexOf("--- a/src/auth.ts") < workEnd);
  assert.ok(workEnd < contextStart);
  assert.ok(contextStart < prompt.text.indexOf("The timeout must remain configurable."));
  assert.deepEqual(
    prompt.sources.map((source) => source.kind),
    ["issue", "pull-request", "pull-request-diff"],
  );
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
    issueContextDepth: 5,
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
    issueContextDepth: 1,
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
    issueContextDepth: 9,
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
  const { GitHubDelegationPromptResolver } = await import("../../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({
    github: new FakeGitHub({ issues: [issue47, parent31] }),
  }));
  const prompt = await adapter.resolve({
    type: "interactive",
    description: "fix the session loss",
    prompt: "Work with me to fix issue #47.",
  }, { authority: "delegation" });

  assert.ok(prompt, "prompt should be resolved");
  assert.ok(prompt.text.includes("Work with me to fix issue #47."));
  assert.deepEqual(prompt.sources, []);
  assert.equal(await adapter.resolve({ type: "interactive", description: "d" }, { authority: "user" }), undefined);
  const interactive = await adapter.resolve({
    type: "interactive", description: "d", prompt: "caching layer",
  }, { authority: "user" });
  assert.ok(interactive, "interactive prompt should be resolved");
  assert.ok(interactive.text.includes("caching layer"));
  assert.deepEqual(interactive.sources, []);

  const explorationInstruction = "Trace authentication refresh and report the relevant control flow.";
  const exploration = await adapter.resolve({
    type: "Explore",
    description: "trace authentication refresh",
    prompt: explorationInstruction,
  }, { authority: "delegation" });
  assert.ok(exploration, "Explore prompt should be resolved");
  assert.equal(exploration.text, explorationInstruction);
  assert.deepEqual(exploration.sources, []);

  const exact = "  Keep /api exactly as written.  \n";
  const preserved = await adapter.resolve({
    type: "interactive",
    description: "exact prompt",
    prompt: exact,
  }, { authority: "user" });
  assert.equal(preserved?.text, exact);
});

test("interactive launches resolve to no prompt so the terminal opens empty", async () => {
  const { GitHubDelegationPromptResolver } = await import("../../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github: new FakeGitHub({}) }));
  for (const type of ["interactive"] as const) {
    assert.equal(await adapter.resolve({ type, description: "d" }, { authority: "user" }), undefined);
    assert.equal(await adapter.resolve({ type, description: "d", prompt: "   " }, { authority: "user" }), undefined);
    const withTopic = await adapter.resolve({ type, description: "d", prompt: "caching layer" }, { authority: "user" });
    assert.ok(withTopic, "withTopic should be resolved");
    assert.equal(withTopic.text.includes("caching layer"), true);
  }
  const doctor = await adapter.resolve({ type: "reviewer", description: "d" }, { authority: "auto-run" });
  assert.notEqual(doctor, undefined);
  assert.ok(doctor!.text.length > 0);
});

test("manual prompt authority never falls back to Auto Run instructions", async () => {
  const { GitHubDelegationPromptResolver } = await import("../../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github: new FakeGitHub({ issues: [issue47] }) }));

  await assert.rejects(
    () => adapter.resolve({ type: "implementer", description: "manual", issues: [47] }, { authority: "delegation" }),
    /Manual delegation requires an explicit prompt/u,
  );
});

test("a pull-request reviewer requires an explicit workflow instruction", async () => {
  const { GitHubDelegationPromptResolver } = await import("../../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github: new FakeGitHub({}) }));

  await assert.rejects(
    () => adapter.resolve({ type: "reviewer", description: "review pull request 42", pullRequest: 42 }, { authority: "auto-run" }),
    /requires an explicit prompt/u,
  );
});

test("additional guidance is the final section after resolved issue and pull-request context", async () => {
  const { GitHubDelegationPromptResolver } = await import("../../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({
    github: new FakeGitHub({
      issues: [issue47, parent31],
      pullRequests: [{ ...pull42, headBranch: "issue/47-token-refresh", baseBranch: "run/test" }],
      diff: "+ refreshEarly();",
    }),
  }));
  const permanentPrompt = "run the full browser suite";
  const guideline = "no unit tests needed";
  // Both configured and one-off guidance share one final, explicit boundary.

  const implementer = await adapter.resolve({
    type: "implementer",
    description: "address issue 47",
    issues: [47],
    prompt: "The checked-out branch is for issue #47. Work only in the directory you started in.",
    permanentPrompt,
    additionalGuideline: guideline,
  }, { authority: "auto-run" });
  const implementerText = implementer?.text ?? "";
  assert.ok(implementer, "implementer prompt should be resolved");
  assert.equal(implementerText.trimEnd().endsWith("</additional-guidance>"), true);
  // The resolved issue context comes first.
  assert.equal(implementerText.indexOf("Refresh the access token before it expires.") < implementerText.indexOf(guideline), true);
  assert.equal(implementerText.indexOf(permanentPrompt) < implementerText.indexOf(guideline), true);
  assert.equal((implementerText.match(/<additional-guidance>/gu) ?? []).length, 1);

  for (const reviewMode of ["afk", "hitl"] as const) {
    const doctor = await adapter.resolve({
      type: "reviewer",
      description: "review pull request 42",
      pullRequest: 42,
      prompt: "Review the accepted issue changes and fix straightforward findings.",
      permanentPrompt,
      additionalGuideline: guideline,
    }, { authority: "auto-run" });
    const doctorText = doctor?.text ?? "";
    assert.ok(doctor, `doctor prompt should be resolved for ${reviewMode}`);
    assert.equal(doctorText.trimEnd().endsWith("</additional-guidance>"), true, reviewMode);
    // The resolved diff comes first.
    assert.equal(doctorText.indexOf("+ refreshEarly();") < doctorText.indexOf(guideline), true, reviewMode);
    assert.equal(doctorText.indexOf(permanentPrompt) < doctorText.indexOf(guideline), true, reviewMode);
    assert.equal((doctorText.match(/<additional-guidance>/gu) ?? []).length, 1, reviewMode);
  }
});

test("prompt authority, not agent type, controls automatic prompt generation", async () => {
  const { GitHubDelegationPromptResolver } = await import("../../src/github/prompt-adapter.js");
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github: new FakeGitHub({}) }));
  // Interactive: the terminal opens empty even though the type can also run
  // unattended; the user types the first message.
  assert.equal(await adapter.resolve({ type: "interactive", description: "d" }, { authority: "user" }), undefined);
  assert.equal(await adapter.resolve({ type: "Explore", description: "d" }, { authority: "user" }), undefined);
  const topic = await adapter.resolve({ type: "Explore", description: "d", prompt: "auth flow" }, { authority: "user" });
  assert.ok(topic, "topic should be resolved");
  assert.equal(topic.text.includes("auth flow"), true);
  const task = await adapter.resolve({ type: "interactive", description: "d", prompt: "find the retry bug" }, { authority: "delegation" });
  assert.ok(task, "task should be resolved");
  assert.equal(task.text.includes("find the retry bug"), true);
  await assert.rejects(
    adapter.resolve({ type: "Explore", description: "d" }, { authority: "auto-run" }),
    /Explore requires an explicit prompt/u,
  );
});

test("an issue-bound Explore launch receives resolved issue context", async () => {
  const { GitHubDelegationPromptResolver } = await import("../../src/github/prompt-adapter.js");
  const github = new FakeGitHub({ issues: [issue47, parent31] });
  const adapter = new GitHubDelegationPromptResolver(new PromptResolver({ github }));

  const prompt = await adapter.resolve({
    type: "Explore",
    description: "explore issue 47",
    issues: [47],
    prompt: "Map relevant files and tests.",
  }, { authority: "auto-run" });

  assert.ok(prompt, "prompt should be resolved");
  assert.ok(prompt.text.includes("Map relevant files and tests."));
  assert.doesNotMatch(prompt.text, /Explore the codebase without modifying files\./u);
  assert.ok(prompt.text.includes("Refresh the access token before it expires"));
  assert.ok(prompt.text.includes("The auth subsystem is replaced end to end"));
  assert.deepEqual(github.issueRequests, [47, 31]);
});
