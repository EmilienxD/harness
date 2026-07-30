import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  GitHubPromptSource,
  IssueSnapshot,
  PullRequestSnapshot,
  ReviewThreadSnapshot,
} from "../claude/prompts.js";

const execFileAsync = promisify(execFile);

export const ABOARD_LABELS = ["spec", "todo", "afk", "hitl"] as const;
export type AboardLabel = (typeof ABOARD_LABELS)[number];

export type GitHubErrorCode =
  | "command-failed"
  | "malformed-output"
  | "missing-todo"
  | "ambiguous-todo"
  | "invalid-finding";

export class GitHubBoundaryError extends Error {
  public constructor(
    public readonly code: GitHubErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GitHubBoundaryError";
  }
}

export interface GhExecutor {
  run(args: readonly string[]): Promise<string>;
}

export class ProcessGhExecutor implements GhExecutor {
  public constructor(private readonly cwd: string) {}

  public async run(args: readonly string[]): Promise<string> {
    try {
      const result = await execFileAsync("gh", [...args], {
        cwd: this.cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      });
      return result.stdout;
    } catch (error) {
      const cause = error as { code?: unknown; stderr?: unknown };
      throw new GitHubBoundaryError("command-failed", "GitHub CLI command failed", {
        exitCode: typeof cause.code === "number" ? cause.code : undefined,
        stderr: typeof cause.stderr === "string" ? cause.stderr.trim().slice(0, 2_000) : undefined,
      });
    }
  }
}

export interface TodoSnapshot {
  readonly number: number;
  readonly body: string;
}

export interface RoadmapIssue {
  readonly number: number;
  readonly title: string;
  readonly disposition: "afk" | "hitl" | "unclassified";
  readonly ready: boolean;
  readonly dependencyNumbers: readonly number[];
}

export interface ReviewFinding {
  readonly body: string;
  readonly path: string;
  readonly line: number;
  readonly side?: "LEFT" | "RIGHT";
}

export interface ReviewState {
  readonly decision: "approved" | "changes-requested" | "reviewed" | "unreviewed";
  readonly unresolvedThreadCount: number;
}

export interface UnreviewedMerge {
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubBoundaryError("malformed-output", `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new GitHubBoundaryError("malformed-output", `${context} must be an array`);
  return value;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string") throw new GitHubBoundaryError("malformed-output", `${context} must be a string`);
  return value;
}

function integer(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new GitHubBoundaryError("malformed-output", `${context} must be a positive integer`);
  }
  return value as number;
}

function nullableInteger(value: unknown, context: string): number | null {
  return value === null ? null : integer(value, context);
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new GitHubBoundaryError("malformed-output", `${context} must be a boolean`);
  return value;
}

function json(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubBoundaryError("malformed-output", `${context} returned invalid JSON`);
  }
}

function labels(value: unknown, context: string): readonly string[] {
  return array(value, context).map((entry, index) => string(record(entry, `${context}[${index}]`).name, `${context}[${index}].name`));
}

function state(value: unknown, context: string): "open" | "closed" {
  const normalized = string(value, context).toLowerCase();
  if (normalized !== "open" && normalized !== "closed") {
    throw new GitHubBoundaryError("malformed-output", `${context} must be OPEN or CLOSED`);
  }
  return normalized;
}

function disposition(issueLabels: readonly string[]): RoadmapIssue["disposition"] {
  const normalized = new Set(issueLabels.map((label) => label.toLowerCase()));
  if (normalized.has("hitl")) return "hitl";
  return normalized.has("afk") ? "afk" : "unclassified";
}

function parseIssue(value: unknown, context: string): IssueSnapshot {
  const item = record(value, context);
  const issueLabels = labels(record(item.labels, `${context}.labels`).nodes, `${context}.labels.nodes`);
  const parent = item.parent === null || item.parent === undefined
    ? undefined
    : integer(record(item.parent, `${context}.parent`).number, `${context}.parent.number`);
  const branches = item.closedByPullRequestsReferences === undefined
    ? []
    : array(record(item.closedByPullRequestsReferences, `${context}.closedByPullRequestsReferences`).nodes, `${context}.closedByPullRequestsReferences.nodes`);
  const branch = branches.length === 0
    ? undefined
    : string(record(branches[0], `${context}.closedByPullRequestsReferences.nodes[0]`).headRefName, `${context}.closedByPullRequestsReferences.nodes[0].headRefName`);
  return {
    number: integer(item.number, `${context}.number`),
    title: string(item.title, `${context}.title`),
    body: string(item.body ?? "", `${context}.body`),
    labels: issueLabels,
    state: state(item.state, `${context}.state`),
    ...(parent === undefined ? {} : { parentIssueNumber: parent }),
    ...(branch === undefined ? {} : { branch }),
  };
}

function repositoryFromGraphql(value: unknown): Record<string, unknown> {
  return record(record(record(value, "GraphQL response").data, "data").repository, "data.repository");
}

const ISSUE_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){number title body state labels(first:20){nodes{name}} parent{number} closedByPullRequestsReferences(first:1){nodes{headRefName}}}}}`;
const ROADMAP_QUERY = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(first:100,states:OPEN){nodes{number title labels(first:20){nodes{name}} blockedBy(first:100){nodes{number state}}}}}}`;
const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number title body state merged headRefName baseRefName headRefOid closingIssuesReferences(first:10){nodes{number}} reviewDecision reviewThreads(first:100){nodes{isResolved}}}}}`;
const THREAD_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line comments(first:100){nodes{body author{login}}}}}}}}`;

export class GitHubClient implements GitHubPromptSource {
  #todoNumber: number | undefined;

  public constructor(private readonly gh: GhExecutor) {}

  public async getTodo(): Promise<TodoSnapshot> {
    const number = await this.#resolveTodo(false);
    if (number === undefined) throw new GitHubBoundaryError("missing-todo", "No open issue has the todo label");
    const issue = await this.getIssue(number);
    if (issue === undefined || issue.state !== "open") {
      this.#todoNumber = undefined;
      throw new GitHubBoundaryError("missing-todo", "The cached TODO issue is missing or closed");
    }
    return { number, body: issue.body };
  }

  public async updateTodo(body: string): Promise<TodoSnapshot> {
    const normalized = body.trim();
    let number = await this.#resolveTodo(true);
    if (number === undefined) {
      await this.gh.run(["label", "create", "todo", "--description", "Project roadmap", "--color", "1D76DB", "--force"]);
      const output = (await this.gh.run(["issue", "create", "--title", "Project TODO", "--body", normalized, "--label", "todo"])).trim();
      const match = /\/issues\/(\d+)\/?$/.exec(output);
      if (match === null) throw new GitHubBoundaryError("malformed-output", "gh issue create did not return an issue URL");
      number = integer(Number(match[1]), "created TODO number");
      this.#todoNumber = number;
    } else {
      await this.gh.run(["issue", "edit", String(number), "--body", normalized]);
    }
    return { number, body: normalized };
  }

  public async getIssue(number: number): Promise<IssueSnapshot | undefined> {
    const data = await this.#graphql(ISSUE_QUERY, { number });
    const issue = repositoryFromGraphql(data).issue;
    return issue === null ? undefined : parseIssue(issue, "data.repository.issue");
  }

  public async listRoadmapIssues(): Promise<readonly RoadmapIssue[]> {
    const data = await this.#graphql(ROADMAP_QUERY);
    const repository = repositoryFromGraphql(data);
    const nodes = array(record(repository.issues, "data.repository.issues").nodes, "data.repository.issues.nodes");
    return nodes.flatMap((value, index) => {
      const item = record(value, `issues[${index}]`);
      const issueLabels = labels(record(item.labels, `issues[${index}].labels`).nodes, `issues[${index}].labels.nodes`);
      if (issueLabels.some((label) => label.toLowerCase() === "spec" || label.toLowerCase() === "todo")) return [];
      const dependencies = array(record(item.blockedBy, `issues[${index}].blockedBy`).nodes, `issues[${index}].blockedBy.nodes`);
      return [{
        number: integer(item.number, `issues[${index}].number`),
        title: string(item.title, `issues[${index}].title`),
        disposition: disposition(issueLabels),
        ready: dependencies.every((dependency, dependencyIndex) => state(record(dependency, `dependency[${dependencyIndex}]`).state, `dependency[${dependencyIndex}].state`) === "closed"),
        dependencyNumbers: dependencies.map((dependency, dependencyIndex) => integer(record(dependency, `dependency[${dependencyIndex}]`).number, `dependency[${dependencyIndex}].number`)),
      }];
    });
  }

  public async getPullRequest(number: number): Promise<PullRequestSnapshot | undefined> {
    const data = await this.#graphql(PR_QUERY, { number });
    const pullRequest = repositoryFromGraphql(data).pullRequest;
    if (pullRequest === null) return undefined;
    const item = record(pullRequest, "data.repository.pullRequest");
    const closing = array(record(item.closingIssuesReferences, "pullRequest.closingIssuesReferences").nodes, "pullRequest.closingIssuesReferences.nodes");
    const parsedState = boolean(item.merged, "pullRequest.merged") ? "merged" : state(item.state, "pullRequest.state");
    return {
      number: integer(item.number, "pullRequest.number"),
      title: string(item.title, "pullRequest.title"),
      body: string(item.body ?? "", "pullRequest.body"),
      headBranch: string(item.headRefName, "pullRequest.headRefName"),
      baseBranch: string(item.baseRefName, "pullRequest.baseRefName"),
      state: parsedState,
      ...(closing.length === 0 ? {} : { issueNumber: integer(record(closing[0], "closing issue").number, "closing issue.number") }),
    };
  }

  public async getPullRequestDiff(number: number): Promise<string> {
    return this.gh.run(["pr", "diff", String(number)]);
  }

  public async getReviewState(number: number): Promise<ReviewState> {
    const data = await this.#graphql(PR_QUERY, { number });
    const item = record(repositoryFromGraphql(data).pullRequest, "pullRequest");
    const decision = item.reviewDecision === null
      ? "unreviewed"
      : string(item.reviewDecision, "pullRequest.reviewDecision").toLowerCase().replace("_", "-") as ReviewState["decision"];
    const threads = array(record(item.reviewThreads, "pullRequest.reviewThreads").nodes, "pullRequest.reviewThreads.nodes");
    return { decision, unresolvedThreadCount: threads.filter((thread, index) => !boolean(record(thread, `thread[${index}]`).isResolved, `thread[${index}].isResolved`)).length };
  }

  public async listReviewThreads(number: number): Promise<readonly ReviewThreadSnapshot[]> {
    const data = await this.#graphql(THREAD_QUERY, { number });
    const pullRequest = repositoryFromGraphql(data).pullRequest;
    if (pullRequest === null) return [];
    const nodes = array(record(record(pullRequest, "pullRequest").reviewThreads, "pullRequest.reviewThreads").nodes, "pullRequest.reviewThreads.nodes");
    return nodes.map((value, index) => {
      const thread = record(value, `thread[${index}]`);
      const comments = array(record(thread.comments, `thread[${index}].comments`).nodes, `thread[${index}].comments.nodes`).map((value, commentIndex) => {
        const comment = record(value, `comment[${commentIndex}]`);
        return { author: string(record(comment.author, `comment[${commentIndex}].author`).login, `comment[${commentIndex}].author.login`), body: string(comment.body, `comment[${commentIndex}].body`) };
      });
      return { id: string(thread.id, `thread[${index}].id`), path: string(thread.path, `thread[${index}].path`), line: nullableInteger(thread.line, `thread[${index}].line`), isResolved: boolean(thread.isResolved, `thread[${index}].isResolved`), comments };
    });
  }

  public async listUnreviewedMerges(since: string): Promise<readonly UnreviewedMerge[]> {
    if (Number.isNaN(Date.parse(since))) throw new RangeError("since must be an ISO timestamp");
    const output = await this.gh.run(["pr", "list", "--state", "merged", "--search", `merged:>=${since}`, "--limit", "100", "--json", "number,title,mergedAt,reviews"]);
    return array(json(output, "merged pull requests"), "merged pull requests").flatMap((value, index) => {
      const item = record(value, `merged pull request[${index}]`);
      const reviews = array(item.reviews, `merged pull request[${index}].reviews`);
      if (reviews.length > 0) return [];
      return [{ number: integer(item.number, `merged pull request[${index}].number`), title: string(item.title, `merged pull request[${index}].title`), mergedAt: string(item.mergedAt, `merged pull request[${index}].mergedAt`) }];
    });
  }

  public async publishReviewFinding(pr: number, finding: ReviewFinding): Promise<void> {
    if (finding.body.trim().length === 0 || finding.path.trim().length === 0 || !Number.isInteger(finding.line) || finding.line <= 0) {
      throw new GitHubBoundaryError("invalid-finding", "A review finding needs a body, path, and positive line");
    }
    const data = await this.#graphql(PR_QUERY, { number: pr });
    const item = record(repositoryFromGraphql(data).pullRequest, "pullRequest");
    await this.gh.run(["api", `repos/{owner}/{repo}/pulls/${pr}/comments`, "--method", "POST", "-f", `body=${finding.body.trim()}`, "-f", `commit_id=${string(item.headRefOid, "pullRequest.headRefOid")}`, "-f", `path=${finding.path.trim()}`, "-F", `line=${finding.line}`, "-f", `side=${finding.side ?? "RIGHT"}`]);
  }

  async #resolveTodo(allowMissing: boolean): Promise<number | undefined> {
    if (this.#todoNumber !== undefined) return this.#todoNumber;
    const output = await this.gh.run(["issue", "list", "--state", "open", "--label", "todo", "--limit", "2", "--json", "number"]);
    const items = array(json(output, "TODO lookup"), "TODO lookup");
    if (items.length > 1) throw new GitHubBoundaryError("ambiguous-todo", "More than one open issue has the todo label");
    if (items.length === 0) return allowMissing ? undefined : undefined;
    this.#todoNumber = integer(record(items[0], "TODO issue").number, "TODO issue.number");
    return this.#todoNumber;
  }

  async #graphql(query: string, variables: Readonly<Record<string, number>> = {}): Promise<unknown> {
    const ownerRepo = record(json(await this.gh.run(["repo", "view", "--json", "owner,name"]), "repository identity"), "repository identity");
    const owner = record(ownerRepo.owner, "repository owner");
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${string(owner.login, "repository owner.login")}`, "-f", `repo=${string(ownerRepo.name, "repository name")}`];
    for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);
    return json(await this.gh.run(args), "GitHub GraphQL");
  }
}
