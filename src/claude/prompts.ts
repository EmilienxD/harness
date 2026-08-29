
import { describeIssueNumbers } from "../shared/issues.js";
import { issueDisposition } from "../shared/labels.js";

export { issueDisposition };

/** Everything a worker needs to know about an issue, already parsed. */
export interface IssueSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  /** The parent issue GitHub associates with this issue, when there is one. */
  readonly parentIssueNumber?: number | undefined;
  /** Sub-issues and same-repository issue references inferred from the body. */
  readonly dependencyIssueNumbers?: readonly number[] | undefined;
}

export interface PullRequestSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: "open" | "closed" | "merged";
  /** The issue this pull request closes, when it declares one. */
  readonly issueNumber?: number | undefined;
}

export interface GitHubPromptSource {
  getIssue(number: number): Promise<IssueSnapshot | undefined>;
  getPullRequest(number: number): Promise<PullRequestSnapshot | undefined>;
  getPullRequestDiff(number: number): Promise<string>;
}

/** The `afk`/`hitl` classification of the work-model section. Absence is legitimate. */
export type IssueDisposition = "afk" | "hitl" | "unclassified";

export type PromptSourceKind =
  | "issue"
  | "parent-issue"
  | "related-issue"
  | "pull-request"
  | "pull-request-diff";

/** A record of what was resolved. Carries counts, never content, so it is loggable. */
export interface PromptSource {
  readonly kind: PromptSourceKind;
  readonly number: number;
  readonly chars: number;
  readonly truncated: boolean;
}

export interface ResolvedPrompt {
  /** A single-line opening usable on its own when the body spills to a file. */
  readonly headline: string;
  readonly body: string;
  readonly text: string;
  readonly sources: readonly PromptSource[];
}

export type PromptResolutionRequest =
  | {
      readonly kind: "implementation";
      readonly instruction: string;
      readonly issueNumbers: readonly number[];
      /** Defaults to recursive resolution for callers outside auto-run. */
      readonly recursiveIssueReferences?: boolean;
    }
  | {
      readonly kind: "issue-context";
      readonly instruction: string;
      readonly issueNumbers: readonly number[];
    }
  | {
      readonly kind: "review";
      readonly instruction: string;
      readonly pullRequestNumber: number;
      readonly focus?: string | undefined;
    }
  | {
      readonly kind: "brainstorm";
      readonly topic?: string | undefined;
      readonly relatedIssueNumbers?: readonly number[] | undefined;
    }
  | { readonly kind: "free-form"; readonly instruction: string };

export interface PromptResolutionLimits {
  readonly issueBodyChars: number;
  readonly parentIssueChars: number;
  readonly relatedIssueChars: number;
  readonly diffChars: number;
  /** Hard bound on recursively resolved parents/dependencies. */
  readonly relatedIssueCount: number;
}

export const DEFAULT_PROMPT_RESOLUTION_LIMITS: PromptResolutionLimits = {
  issueBodyChars: 20_000,
  parentIssueChars: 8_000,
  relatedIssueChars: 1_500,
  diffChars: 40_000,
  relatedIssueCount: 50,
};

export type PromptResolutionErrorCode =
  | "issue-not-found"
  | "pull-request-not-found"
  | "empty-instruction"
  | "no-issue";

export class PromptResolutionError extends Error {
  public constructor(
    public readonly code: PromptResolutionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Excerpt {
  readonly text: string;
  readonly truncated: boolean;
}

function excerpt(text: string, limit: number, pointer?: string): Excerpt {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return { text: trimmed, truncated: false };
  const suffix = pointer === undefined
    ? "…truncated by aboard. Base the task only on the supplied context."
    : `…truncated. Read the rest with \`${pointer}\`.`;
  return {
    text: `${trimmed.slice(0, limit).trimEnd()}\n\n${suffix}`,
    truncated: true,
  };
}

function requireInstruction(instruction: string): string {
  const trimmed = instruction.trim();
  if (trimmed.length === 0) {
    throw new PromptResolutionError(
      "empty-instruction",
      "An automated worker needs a non-empty instruction",
    );
  }
  return trimmed;
}

function dispositionGuidance(disposition: IssueDisposition): string {
  switch (disposition) {
    case "afk":
      return "This issue is labelled `[AI]-afk`: aboard will commit your change, open a pull request, and merge it without further human review. Leave the work in the working tree and make sure the checks you can run pass first.";
    case "hitl":
      return "This issue is labelled `[AI]-hitl`: aboard will commit your change and open a pull request, then wait for the user to review and merge it. Leave the work in the working tree, and make your final message a clear account of what you changed and why.";
    case "unclassified":
      return "This issue carries neither `[AI]-afk` nor `[AI]-hitl`, which is a legitimate but unresolved state. Leave the work in the working tree and say in your final message that the issue is unclassified.";
  }
}

class PromptBuilder {
  readonly #sections: string[] = [];
  readonly #sources: PromptSource[] = [];

  public section(heading: string | undefined, content: string): void {
    const trimmed = content.trim();
    if (trimmed.length === 0) return;
    this.#sections.push(heading === undefined ? trimmed : `## ${heading}\n\n${trimmed}`);
  }

  public source(
    kind: PromptSourceKind,
    number: number,
    content: Excerpt,
  ): void {
    this.#sources.push({
      kind,
      number,
      chars: content.text.length,
      truncated: content.truncated,
    });
  }

  public build(headline: string): ResolvedPrompt {
    const body = this.#sections.join("\n\n");
    return {
      headline,
      body,
      text: body.length === 0 ? headline : `${headline}\n\n${body}`,
      sources: [...this.#sources],
    };
  }
}

/** Wraps caller-supplied text as a prompt without resolving anything. */
export function resolvedPromptFromText(text: string): ResolvedPrompt {
  const trimmed = text.trim();
  const breakIndex = trimmed.indexOf("\n");
  const headline = breakIndex === -1 ? trimmed : trimmed.slice(0, breakIndex).trim();
  const body = breakIndex === -1 ? "" : trimmed.slice(breakIndex + 1).trim();
  return { headline, body, text: trimmed, sources: [] };
}

export interface PromptResolverOptions {
  readonly github: GitHubPromptSource;
  readonly limits?: Partial<PromptResolutionLimits>;
}

export class PromptResolver {
  readonly #github: GitHubPromptSource;
  readonly #limits: PromptResolutionLimits;

  public constructor(options: PromptResolverOptions) {
    this.#github = options.github;
    this.#limits = { ...DEFAULT_PROMPT_RESOLUTION_LIMITS, ...options.limits };
  }

  public async resolve(
    request: PromptResolutionRequest,
  ): Promise<ResolvedPrompt | undefined> {
    switch (request.kind) {
      case "implementation":
        return this.#resolveImplementation(request);
      case "issue-context":
        return this.#resolveIssueContext(request);
      case "review":
        return this.#resolveReview(request);
      case "brainstorm":
        return this.#resolveBrainstorm(request);
      case "free-form": {
        const instruction = requireInstruction(request.instruction);
        return resolvedPromptFromText(instruction);
      }
    }
  }

  async #requireIssue(number: number): Promise<IssueSnapshot> {
    const issue = await this.#github.getIssue(number);
    if (issue === undefined) {
      throw new PromptResolutionError("issue-not-found", `Issue #${number} was not found`);
    }
    return issue;
  }

  async #requirePullRequest(number: number): Promise<PullRequestSnapshot> {
    const pullRequest = await this.#github.getPullRequest(number);
    if (pullRequest === undefined) {
      throw new PromptResolutionError(
        "pull-request-not-found",
        `Pull request #${number} was not found`,
      );
    }
    return pullRequest;
  }

  async #fetchIssues(issueNumbers: readonly number[]): Promise<readonly [IssueSnapshot, ...IssueSnapshot[]]> {
    const [first, ...rest] = [...new Set(issueNumbers)];
    if (first === undefined) {
      throw new PromptResolutionError("no-issue", "An issue-bound prompt needs at least one issue number");
    }
    const primary = await this.#requireIssue(first);
    const others: IssueSnapshot[] = [];
    for (const number of rest) others.push(await this.#requireIssue(number));
    return [primary, ...others];
  }

  async #issueSections(
    builder: PromptBuilder,
    issues: readonly IssueSnapshot[],
    pointers: boolean,
    recursiveIssueReferences = true,
  ): Promise<void> {
    for (const issue of issues) {
      const body = excerpt(
        issue.body,
        this.#limits.issueBodyChars,
        pointers ? `gh issue view ${issue.number}` : undefined,
      );
      builder.section(`Issue #${issue.number} — ${issue.title}`, body.text);
      builder.source("issue", issue.number, body);
    }

    const visited = new Set(issues.map((issue) => issue.number));
    const pending: { readonly number: number; readonly kind: "parent-issue" | "related-issue" }[] = [];
    const enqueue = (number: number | undefined, kind: "parent-issue" | "related-issue"): void => {
      if (number === undefined || visited.has(number)) return;
      // Mark on enqueue, not after the read: siblings can point at each other
      // (or themselves through a parent) and must still cost one fetch.
      visited.add(number);
      pending.push({ number, kind });
    };
    for (const issue of issues) enqueue(issue.parentIssueNumber, "parent-issue");
    for (const issue of issues) {
      for (const number of issue.dependencyIssueNumbers ?? []) enqueue(number, "related-issue");
    }

    let attempted = 0;
    while (pending.length > 0 && attempted < this.#limits.relatedIssueCount) {
      const next = pending.shift()!;
      attempted += 1;
      const related = await this.#github.getIssue(next.number);
      // A missing link may name a pull request or deleted issue. It stays in
      // `visited`, so a cycle through it still cannot trigger repeated reads.
      if (related === undefined) continue;
      const limit = next.kind === "parent-issue"
        ? this.#limits.parentIssueChars
        : this.#limits.relatedIssueChars;
      const relatedBody = excerpt(
        related.body,
        limit,
        pointers ? `gh issue view ${related.number}` : undefined,
      );
      builder.section(
        `${next.kind === "parent-issue" ? "Parent issue" : "Related issue"} #${related.number} — ${related.title}`,
        relatedBody.text,
      );
      builder.source(next.kind, related.number, relatedBody);
      if (recursiveIssueReferences) {
        enqueue(related.parentIssueNumber, "parent-issue");
        for (const number of related.dependencyIssueNumbers ?? []) enqueue(number, "related-issue");
      }
    }
  }

  async #resolveImplementation(
    request: Extract<PromptResolutionRequest, { kind: "implementation" }>,
  ): Promise<ResolvedPrompt> {
    const instruction = requireInstruction(request.instruction);
    const issues = await this.#fetchIssues(request.issueNumbers);
    const [primary] = issues;
    const builder = new PromptBuilder();

    builder.section(undefined, instruction);

    await this.#issueSections(builder, issues, true, request.recursiveIssueReferences);
    // The disposition is the primary issue's: it decides what happens to the
    // change, and the engine launches one implementer per issue.
    builder.section("Disposition", dispositionGuidance(issueDisposition(primary.labels)));
    return builder.build(`Address issue #${primary.number} — ${primary.title}.`);
  }

  async #resolveIssueContext(
    request: Extract<PromptResolutionRequest, { kind: "issue-context" }>,
  ): Promise<ResolvedPrompt> {
    const instruction = requireInstruction(request.instruction);
    const issues = await this.#fetchIssues(request.issueNumbers);
    const [primary] = issues;
    const named = describeIssueNumbers(issues.map((issue) => issue.number));
    const builder = new PromptBuilder();
    if (issues.length > 1) builder.section(undefined, `You have the resolved context for ${named}.`);
    builder.section(undefined, instruction);

    await this.#issueSections(builder, issues, false);
    // A single issue keeps its title in the headline; several would overrun the
    // one line that also serves as the spill stub.
    return builder.build(
      issues.length === 1
        ? `Use the resolved context for issue #${primary.number} — ${primary.title}.`
        : `Use the resolved context for ${named}.`,
    );
  }

  async #resolveReview(
    request: Extract<PromptResolutionRequest, { kind: "review" }>,
  ): Promise<ResolvedPrompt> {
    const instruction = requireInstruction(request.instruction);
    const pullRequest = await this.#requirePullRequest(request.pullRequestNumber);
    const builder = new PromptBuilder();

    builder.section(
      undefined,
      `You are reviewing pull request #${pullRequest.number} (\`${pullRequest.headBranch}\` into \`${pullRequest.baseBranch}\`), and that branch is already checked out.`,
    );
    builder.section(undefined, instruction);
    if (request.focus !== undefined && request.focus.trim().length > 0) {
      builder.section("Requested focus", request.focus);
    }

    const description = excerpt(
      pullRequest.body,
      this.#limits.issueBodyChars,
      `gh pr view ${pullRequest.number}`,
    );
    builder.section(
      `Pull request #${pullRequest.number} — ${pullRequest.title}`,
      description.text,
    );
    builder.source("pull-request", pullRequest.number, description);

    if (pullRequest.issueNumber !== undefined) {
      const issue = await this.#github.getIssue(pullRequest.issueNumber);
      if (issue !== undefined) {
        const issueBody = excerpt(
          issue.body,
          this.#limits.issueBodyChars,
          `gh issue view ${issue.number}`,
        );
        builder.section(
          `Contract — issue #${issue.number} — ${issue.title}`,
          issueBody.text,
        );
        builder.source("issue", issue.number, issueBody);
      }
    }

    const diff = excerpt(
      await this.#github.getPullRequestDiff(pullRequest.number),
      this.#limits.diffChars,
      `gh pr diff ${pullRequest.number}`,
    );
    builder.section("Diff", `\`\`\`diff\n${diff.text}\n\`\`\``);
    builder.source("pull-request-diff", pullRequest.number, diff);

    return builder.build(
      `Review pull request #${pullRequest.number} — ${pullRequest.title}.`,
    );
  }

  async #resolveBrainstorm(
    request: Extract<PromptResolutionRequest, { kind: "brainstorm" }>,
  ): Promise<ResolvedPrompt | undefined> {
    const topic = request.topic?.trim() ?? "";
    const relatedNumbers = request.relatedIssueNumbers ?? [];
    // A bare `/brainstorm` opens an empty prompt for the user.
    if (topic.length === 0 && relatedNumbers.length === 0) return undefined;

    const builder = new PromptBuilder();
    if (topic.length > 0) builder.section(undefined, topic);

    for (const number of relatedNumbers) {
      const issue = await this.#github.getIssue(number);
      if (issue === undefined) continue;
      const body = excerpt(
        issue.body,
        this.#limits.relatedIssueChars,
        `gh issue view ${issue.number}`,
      );
      builder.section(
        `Related issue #${issue.number} — ${issue.title} (${issue.state})`,
        body.text,
      );
      builder.source("related-issue", issue.number, body);
    }

    return builder.build(
      topic.length === 0
        ? "Brainstorm the related issues below."
        : `Brainstorm: ${resolvedPromptFromText(topic).headline}`,
    );
  }
}

/** A redacted, loggable summary. Never includes prompt content. */
export function describeResolvedPrompt(prompt: ResolvedPrompt | undefined): string {
  if (prompt === undefined) return "prompt=none";
  const sources = prompt.sources
    .map(
      (source) =>
        `${source.kind}#${source.number}(${source.chars}${source.truncated ? ",truncated" : ""})`,
    )
    .join(",");
  return `prompt=${prompt.text.length} chars${sources.length === 0 ? "" : ` sources=${sources}`}`;
}
