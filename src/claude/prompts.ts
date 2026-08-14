/**
 * Prompt resolution before launch (spec section 5.8).
 *
 * The bridge resolves everything a worker needs and hands it over in the first
 * prompt: workers do not spend a tool call and a context window of `gh` output
 * fetching their own instructions. GitHub access is an injected port so this
 * layer stays testable without a repository or the `gh` CLI.
 */

import { issueDisposition } from "../shared/labels.js";

export { issueDisposition };

/** Everything a worker needs to know about an issue, already parsed. */
export interface IssueSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  /** The umbrella `spec` issue this issue implements, when there is one. */
  readonly parentIssueNumber?: number | undefined;
  /** A branch GitHub already associates with the issue, when there is one. */
  readonly branch?: string | undefined;
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

export interface ReviewComment {
  readonly author: string;
  readonly body: string;
}

export interface ReviewThreadSnapshot {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly isResolved: boolean;
  readonly comments: readonly ReviewComment[];
}

export interface GitHubPromptSource {
  getIssue(number: number): Promise<IssueSnapshot | undefined>;
  getPullRequest(number: number): Promise<PullRequestSnapshot | undefined>;
  getPullRequestDiff(number: number): Promise<string>;
  listReviewThreads(number: number): Promise<readonly ReviewThreadSnapshot[]>;
}

/** The `afk`/`hitl` classification of the work-model section. Absence is legitimate. */
export type IssueDisposition = "afk" | "hitl" | "unclassified";

export type PromptSourceKind =
  | "issue"
  | "parent-spec"
  | "related-issue"
  | "pull-request"
  | "pull-request-diff"
  | "review-threads";

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
      readonly issueNumber: number;
      /** Overrides the branch GitHub reports, when the caller knows better. */
      readonly branch?: string | undefined;
    }
  | {
      readonly kind: "issue-context";
      readonly instruction: string;
      readonly issueNumber: number;
    }
  | {
      readonly kind: "review";
      readonly instruction: string;
      readonly pullRequestNumber: number;
      readonly focus?: string | undefined;
    }
  | {
      readonly kind: "fix";
      readonly instruction: string;
      readonly pullRequestNumber: number;
    }
  | {
      readonly kind: "brainstorm";
      readonly topic?: string | undefined;
      readonly relatedIssueNumbers?: readonly number[] | undefined;
    }
  | { readonly kind: "free-form"; readonly instruction: string };

export interface PromptResolutionLimits {
  readonly issueBodyChars: number;
  readonly parentSpecChars: number;
  readonly relatedIssueChars: number;
  readonly diffChars: number;
  readonly reviewThreadChars: number;
}

export const DEFAULT_PROMPT_RESOLUTION_LIMITS: PromptResolutionLimits = {
  issueBodyChars: 20_000,
  parentSpecChars: 8_000,
  relatedIssueChars: 1_500,
  diffChars: 40_000,
  reviewThreadChars: 12_000,
};

export type PromptResolutionErrorCode =
  | "issue-not-found"
  | "pull-request-not-found"
  | "empty-instruction";

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

/**
 * The disposition tells the worker what will happen to its change, not what to
 * do about it: the extension owns every git and GitHub side effect, so no
 * disposition ever asks an agent to commit, open, or merge anything
 * (`AGENTS.md`).
 */
function dispositionGuidance(disposition: IssueDisposition): string {
  switch (disposition) {
    case "afk":
      return "This issue is labelled `ai:afk`: aboard will commit your change, open a pull request, and merge it without further human review. Leave the work in the working tree and make sure the checks you can run pass first.";
    case "hitl":
      return "This issue is labelled `ai:hitl`: aboard will commit your change and open a pull request, then wait for the user to review and merge it. Leave the work in the working tree, and make your final message a clear account of what you changed and why.";
    case "unclassified":
      return "This issue carries neither `ai:afk` nor `ai:hitl`, which is a legitimate but unresolved state. Leave the work in the working tree and say in your final message that the issue is unclassified.";
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

  /**
   * Resolves a complete first prompt. Returns `undefined` only when there is
   * genuinely nothing to say — an interactive agent the user will type into
   * (spec section 5.4).
   */
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
      case "fix":
        return this.#resolveFix(request);
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

  async #resolveImplementation(
    request: Extract<PromptResolutionRequest, { kind: "implementation" }>,
  ): Promise<ResolvedPrompt> {
    const instruction = requireInstruction(request.instruction);
    const issue = await this.#requireIssue(request.issueNumber);
    const builder = new PromptBuilder();

    const branch = request.branch ?? issue.branch;
    builder.section(
      undefined,
      branch === undefined
        ? `You are implementing issue #${issue.number}. Create or switch to a dedicated branch for it before making changes.`
        : `You are implementing issue #${issue.number} on branch \`${branch}\`.`,
    );
    builder.section(undefined, instruction);

    const body = excerpt(
      issue.body,
      this.#limits.issueBodyChars,
      `gh issue view ${issue.number}`,
    );
    builder.section(`Issue #${issue.number} — ${issue.title}`, body.text);
    builder.source("issue", issue.number, body);

    if (issue.parentIssueNumber !== undefined) {
      const parent = await this.#github.getIssue(issue.parentIssueNumber);
      if (parent !== undefined) {
        const parentBody = excerpt(
          parent.body,
          this.#limits.parentSpecChars,
          `gh issue view ${parent.number}`,
        );
        builder.section(
          `Parent spec #${parent.number} — ${parent.title}`,
          parentBody.text,
        );
        builder.source("parent-spec", parent.number, parentBody);
      }
    }

    builder.section("Disposition", dispositionGuidance(issueDisposition(issue.labels)));
    return builder.build(`Implement issue #${issue.number} — ${issue.title}.`);
  }

  async #resolveIssueContext(
    request: Extract<PromptResolutionRequest, { kind: "issue-context" }>,
  ): Promise<ResolvedPrompt> {
    const instruction = requireInstruction(request.instruction);
    const issue = await this.#requireIssue(request.issueNumber);
    const builder = new PromptBuilder();
    builder.section(undefined, instruction);

    const body = excerpt(issue.body, this.#limits.issueBodyChars);
    builder.section(`Issue #${issue.number} — ${issue.title}`, body.text);
    builder.source("issue", issue.number, body);

    if (issue.parentIssueNumber !== undefined) {
      const parent = await this.#github.getIssue(issue.parentIssueNumber);
      if (parent !== undefined) {
        const parentBody = excerpt(parent.body, this.#limits.parentSpecChars);
        builder.section(`Parent spec #${parent.number} — ${parent.title}`, parentBody.text);
        builder.source("parent-spec", parent.number, parentBody);
      }
    }

    return builder.build(`Use the resolved context for issue #${issue.number} — ${issue.title}.`);
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

  async #resolveFix(
    request: Extract<PromptResolutionRequest, { kind: "fix" }>,
  ): Promise<ResolvedPrompt> {
    const instruction = requireInstruction(request.instruction);
    const pullRequest = await this.#requirePullRequest(request.pullRequestNumber);
    const threads = (
      await this.#github.listReviewThreads(pullRequest.number)
    ).filter((thread) => !thread.isResolved);
    const builder = new PromptBuilder();

    builder.section(
      undefined,
      `You are addressing review feedback on pull request #${pullRequest.number}, branch \`${pullRequest.headBranch}\`. Commit your changes and reply to each thread you address.`,
    );
    builder.section(undefined, instruction);

    const rendered = threads
      .map((thread) => {
        const location =
          thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
        const comments = thread.comments
          .map((comment) => `> **${comment.author}**: ${comment.body.trim()}`)
          .join("\n>\n");
        return `### ${location} (thread \`${thread.id}\`)\n\n${comments}`;
      })
      .join("\n\n");
    const threadExcerpt = excerpt(
      rendered,
      this.#limits.reviewThreadChars,
      `gh pr view ${pullRequest.number} --comments`,
    );
    builder.section(
      `Unresolved review threads (${threads.length})`,
      threads.length === 0
        ? "None are unresolved. Confirm this before changing anything."
        : threadExcerpt.text,
    );
    builder.source("review-threads", pullRequest.number, threadExcerpt);

    return builder.build(
      `Address review feedback on pull request #${pullRequest.number} — ${pullRequest.title}.`,
    );
  }

  async #resolveBrainstorm(
    request: Extract<PromptResolutionRequest, { kind: "brainstorm" }>,
  ): Promise<ResolvedPrompt | undefined> {
    const topic = request.topic?.trim() ?? "";
    const relatedNumbers = request.relatedIssueNumbers ?? [];
    // A bare `/brainstorm` opens an empty prompt for the user (spec section 5.4).
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
