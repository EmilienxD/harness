import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  GitHubPromptSource,
  IssueCommentSnapshot,
  IssueSnapshot,
  PullRequestSnapshot,
} from "../claude/prompts.js";
import {
  ROADMAP_BODY_LIMIT,
  createTasks,
  describeSubjectRejection,
  nearBodyLimit,
  numberedTasks,
  parseRoadmap,
  updateTask,
  type RoadmapCreateInput,
  type RoadmapEdit,
  type RoadmapTask,
  type RoadmapUpdateInput,
} from "../domain/roadmap.js";
import type { CandidateIssue } from "../domain/auto-run.js";
import { referencedIssueNumbers } from "../shared/issues.js";
import { LABEL_HITL, LABEL_TODO, hasLabel, issueDisposition } from "../shared/labels.js";

export { ABOARD_LABELS } from "../shared/labels.js";
export type { AboardLabel } from "../shared/labels.js";

const execFileAsync = promisify(execFile);

export type GitHubErrorCode =
  | "command-failed"
  | "issue-not-found"
  | "malformed-output"
  | "missing-todo"
  | "unknown-task"
  | "expectation-mismatch"
  | "invalid-subject"
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
  public constructor(
    private readonly cwd: string,
    private readonly execute: (args: readonly string[], cwd: string) => Promise<string> = runGhProcess,
  ) {}

  public async run(args: readonly string[]): Promise<string> {
    try {
      return await this.execute(args, this.cwd);
    } catch (error) {
      const cause = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
      // gh exits nonzero for a missing issue, even though GraphQL supplies the
      // expected null. Only that exact lookup failure is optional context.
      const missingIssue = args[0] === "api" && args[1] === "graphql" && isMissingIssueResponse(cause.stdout);
      throw new GitHubBoundaryError(missingIssue ? "issue-not-found" : "command-failed", "GitHub CLI command failed", {
        exitCode: typeof cause.code === "number" ? cause.code : undefined,
        stderr: typeof cause.stderr === "string" ? cause.stderr.trim().slice(0, 2_000) : undefined,
      });
    }
  }
}

async function runGhProcess(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFileAsync("gh", [...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}

function isMissingIssueResponse(stdout: unknown): boolean {
  if (typeof stdout !== "string") return false;
  try {
    const response = record(JSON.parse(stdout) as unknown, "GraphQL response");
    const repository = repositoryFromGraphql(response);
    const errors = array(response.errors, "GraphQL errors");
    return repository.issue === null && errors.length > 0 && errors.every((value) => {
      const error = record(value, "GraphQL error");
      return error.type === "NOT_FOUND" && Array.isArray(error.path)
        && error.path.length === 2 && error.path[0] === "repository" && error.path[1] === "issue";
    });
  } catch {
    return false;
  }
}

export interface RoadmapSnapshot {
  readonly number: number;
  readonly body: string;
  readonly tasks: readonly RoadmapTask[];
  readonly duplicateSubjects: readonly string[];
  readonly carrierCount: number;
  readonly nearBound: boolean;
}

export interface RoadmapWriteResult {
  readonly issue: number;
  /** Positions of the tasks the call created, in the order their subjects were given. */
  readonly positions?: readonly number[];
  /** The edited task's position after the edit, absent when it was deleted. */
  readonly task?: number | undefined;
  readonly tasks?: readonly string[];
  readonly notices: readonly string[];
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

/** GraphQL spells these APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; null is an unreviewed pull request. */
function reviewDecision(value: unknown, context: string): ReviewState["decision"] {
  if (value === null || value === undefined) return "unreviewed";
  return string(value, context).toLowerCase().replace("_", "-") as ReviewState["decision"];
}

export interface UnreviewedMerge {
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
}

/** An open pull request as the Manager's briefing needs it: enough to name it. */
export interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly reviewState: string;
}

export interface BranchPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly head: string;
  readonly base: string;
}

/** The complete open-issue queue used by auto-run. */
export interface ImplementableIssues {
  readonly candidates: readonly CandidateIssue[];
}

export interface CreatePullRequestInput {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

export interface PullRequestMergeFacts {
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
  readonly url: string;
  readonly headSha: string;
  /** GitHub's resulting commit once merged. */
  readonly mergeCommitSha?: string;
  /** Already in the pull-request query, so callers need no second round trip for it. */
  readonly reviewDecision: ReviewState["decision"];
}

function mergeability(value: unknown): PullRequestMergeFacts["mergeable"] {
  switch (value) {
    case "MERGEABLE": return "mergeable";
    case "CONFLICTING": return "conflicting";
    default: return "unknown";
  }
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

interface PageInfo {
  readonly nextCursor: string | undefined;
}

function pageInfo(value: unknown, context: string): PageInfo {
  const info = record(value, context);
  const hasNextPage = boolean(info.hasNextPage, `${context}.hasNextPage`);
  const endCursor = info.endCursor === null || info.endCursor === undefined
    ? undefined
    : string(info.endCursor, `${context}.endCursor`);
  if (hasNextPage && (endCursor === undefined || endCursor.length === 0)) {
    throw new GitHubBoundaryError("malformed-output", `${context}.endCursor must identify the next page`);
  }
  return { nextCursor: hasNextPage ? endCursor : undefined };
}

interface LabelPage extends PageInfo {
  readonly labels: readonly string[];
}

function parseLabelPage(value: unknown, context: string): LabelPage {
  const connection = record(value, context);
  return {
    labels: labels(connection.nodes, `${context}.nodes`),
    ...pageInfo(connection.pageInfo, `${context}.pageInfo`),
  };
}

interface Dependency {
  readonly number: number;
  readonly state: "open" | "closed";
}

interface DependencyPage extends PageInfo {
  readonly dependencies: readonly Dependency[];
}

interface IssueNumberPage extends PageInfo {
  readonly numbers: readonly number[];
}

interface IssueCommentPage extends PageInfo {
  readonly comments: IssueSnapshot["comments"];
}

function parseIssueCommentPage(value: unknown, context: string): IssueCommentPage {
  if (value === undefined || value === null) {
    return { comments: [], nextCursor: undefined };
  }
  const connection = record(value, context);
  const nodes = connection.nodes === undefined ? [] : array(connection.nodes, `${context}.nodes`);
  const comments = nodes.map((node, index) => {
    const entry = record(node, `${context}.nodes[${index}]`);
    const authorLogin = entry.author === undefined || entry.author === null
      ? undefined
      : string(record(entry.author, `${context}.nodes[${index}].author`).login, `${context}.nodes[${index}].author.login`);
    return {
      ...(authorLogin === undefined ? {} : { authorLogin }),
      body: string(entry.body ?? "", `${context}.nodes[${index}].body`),
    };
  });
  const paging = connection.pageInfo === undefined
    ? { nextCursor: undefined }
    : pageInfo(connection.pageInfo, `${context}.pageInfo`);
  return { comments, nextCursor: paging.nextCursor };
}

function parseIssueNumberPage(value: unknown, context: string): IssueNumberPage {
  if (value === undefined || value === null) {
    return { numbers: [], nextCursor: undefined };
  }
  const connection = record(value, context);
  const nodes = connection.nodes === undefined ? [] : array(connection.nodes, `${context}.nodes`);
  const numbers = nodes.map((node, index) =>
    integer(record(node, `${context}.nodes[${index}]`).number, `${context}.nodes[${index}].number`));
  const paging = connection.pageInfo === undefined
    ? { nextCursor: undefined }
    : pageInfo(connection.pageInfo, `${context}.pageInfo`);
  return { numbers, nextCursor: paging.nextCursor };
}

function parseDependencyPage(value: unknown, context: string): DependencyPage {
  const connection = record(value, context);
  const dependencies = array(connection.nodes, `${context}.nodes`).map((dependency, index) => {
    const entry = record(dependency, `${context}.nodes[${index}]`);
    return {
      number: integer(entry.number, `${context}.nodes[${index}].number`),
      state: state(entry.state, `${context}.nodes[${index}].state`),
    };
  });
  return { dependencies, ...pageInfo(connection.pageInfo, `${context}.pageInfo`) };
}

interface ParsedIssue {
  readonly snapshot: IssueSnapshot;
  readonly nextLabelCursor: string | undefined;
  readonly nextSubIssueCursor: string | undefined;
  readonly nextCommentCursor: string | undefined;
}

function parseIssue(
  value: unknown,
  context: string,
  repository: { readonly owner: string; readonly repo: string },
): ParsedIssue {
  const item = record(value, context);
  const labelPage = parseLabelPage(item.labels, `${context}.labels`);
  const subIssuePage = parseIssueNumberPage(item.subIssues, `${context}.subIssues`);
  const commentPage = parseIssueCommentPage(item.comments, `${context}.comments`);
  const parent = item.parent === null || item.parent === undefined
    ? undefined
    : integer(record(item.parent, `${context}.parent`).number, `${context}.parent.number`);
  const body = string(item.body ?? "", `${context}.body`);
  return {
    snapshot: {
      number: integer(item.number, `${context}.number`),
      title: string(item.title, `${context}.title`),
      body,
      labels: labelPage.labels,
      state: state(item.state, `${context}.state`),
      comments: commentPage.comments,
      ...(parent === undefined ? {} : { parentIssueNumber: parent }),
      dependencyIssueNumbers: [...new Set([
        ...subIssuePage.numbers,
        ...referencedIssueNumbers(body, repository),
      ])],
    },
    nextLabelCursor: labelPage.nextCursor,
    nextSubIssueCursor: subIssuePage.nextCursor,
    nextCommentCursor: commentPage.nextCursor,
  };
}

/** One row of the open-issue page, parsed once and projected two ways. */
interface OpenIssueRow {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly labels: readonly string[];
  readonly dependencyNumbers: readonly number[];
  readonly openBlockedByNumbers: readonly number[];
  readonly orderingDependencyNumbers: readonly number[];
}

interface ParsedOpenIssue {
  readonly row: OpenIssueRow;
  readonly dependencies: readonly Dependency[];
  readonly subIssueNumbers: readonly number[];
  readonly nextLabelCursor: string | undefined;
  readonly nextDependencyCursor: string | undefined;
  readonly nextSubIssueCursor: string | undefined;
}

function parseOpenIssue(
  value: unknown,
  context: string,
  repository: { readonly owner: string; readonly repo: string },
): ParsedOpenIssue {
  const item = record(value, context);
  const labelPage = parseLabelPage(item.labels, `${context}.labels`);
  const dependencyPage = parseDependencyPage(item.blockedBy, `${context}.blockedBy`);
  const subIssuePage = parseIssueNumberPage(item.subIssues, `${context}.subIssues`);
  const body = string(item.body ?? "", `${context}.body`);
  const references = referencedIssueNumbers(body, repository);
  return {
    row: {
      number: integer(item.number, `${context}.number`),
      title: string(item.title, `${context}.title`),
      createdAt: string(item.createdAt, `${context}.createdAt`),
      labels: labelPage.labels,
      dependencyNumbers: dependencyPage.dependencies.map((dependency) => dependency.number),
      openBlockedByNumbers: dependencyPage.dependencies.flatMap((dependency) => dependency.state === "open" ? [dependency.number] : []),
      orderingDependencyNumbers: [...new Set([
        ...dependencyPage.dependencies.map((dependency) => dependency.number),
        ...subIssuePage.numbers,
        ...references,
      ])],
    },
    dependencies: dependencyPage.dependencies,
    subIssueNumbers: subIssuePage.numbers,
    nextLabelCursor: labelPage.nextCursor,
    nextDependencyCursor: dependencyPage.nextCursor,
    nextSubIssueCursor: subIssuePage.nextCursor,
  };
}

interface TodoCarrier {
  readonly number: number;
  readonly body: string;
  readonly createdAt: string;
}

/** Newest first, ties on the lowest number: the one rule read and write share. */
function sortedCarriers(carriers: readonly TodoCarrier[]): readonly TodoCarrier[] {
  return [...carriers].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.number - right.number);
}

function repositoryFromGraphql(value: unknown): Record<string, unknown> {
  return record(record(record(value, "GraphQL response").data, "data").repository, "data.repository");
}

const ISSUE_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){number title body state labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}} parent{number} subIssues(first:100){nodes{number} pageInfo{hasNextPage endCursor}} comments(first:100){nodes{author{login} body} pageInfo{hasNextPage endCursor}}}}}`;
const OPEN_ISSUES_QUERY = `query($owner:String!,$repo:String!,$after:String){repository(owner:$owner,name:$repo){issues(first:100,after:$after,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title body createdAt labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}} subIssues(first:100){nodes{number} pageInfo{hasNextPage endCursor}} blockedBy(first:100){nodes{number state} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}`;
const ISSUE_LABELS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){issue(number:$number){labels(first:100,after:$after){nodes{name} pageInfo{hasNextPage endCursor}}}}}`;
const ISSUE_BLOCKERS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){issue(number:$number){blockedBy(first:100,after:$after){nodes{number state} pageInfo{hasNextPage endCursor}}}}}`;
const ISSUE_SUBISSUES_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){issue(number:$number){subIssues(first:100,after:$after){nodes{number} pageInfo{hasNextPage endCursor}}}}}`;
const ISSUE_COMMENTS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){issue(number:$number){comments(first:100,after:$after){nodes{author{login} body} pageInfo{hasNextPage endCursor}}}}}`;
const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number title body state merged mergeable url headRefName baseRefName headRefOid mergeCommit{oid} closingIssuesReferences(first:10){nodes{number}} reviewDecision reviewThreads(first:100){nodes{isResolved}}}}}`;

export class GitHubClient implements GitHubPromptSource {
  #identity: Promise<{ readonly owner: string; readonly repo: string }> | undefined;

  #minted: number | undefined;

  public constructor(private readonly gh: GhExecutor) {}

  public async checkAuthentication(): Promise<void> {
    const identity = await this.#resolveOwnerRepo();
    this.#identity = Promise.resolve(identity);
  }

  public async readRoadmap(): Promise<RoadmapSnapshot | undefined> {
    const carriers = await this.#scanTodoCarriers();
    const chosen = carriers[0];
    if (chosen === undefined) return undefined;
    const parsed = parseRoadmap(chosen.body);
    return {
      number: chosen.number,
      body: chosen.body,
      tasks: parsed.tasks,
      duplicateSubjects: parsed.duplicateSubjects,
      carrierCount: carriers.length,
      nearBound: nearBodyLimit(chosen.body),
    };
  }

  public async createRoadmapTasks(input: RoadmapCreateInput): Promise<RoadmapWriteResult> {
    const carriers = await this.#scanTodoCarriers();
    const chosen = carriers[0];
    if (chosen === undefined) {
      const edit = this.#applied(createTasks("", input), []);
      const minted = await this.#mintRoadmap(edit.body);
      return { issue: minted.number, positions: edit.value.positions, notices: [`Created issue #${minted.number} and labelled it \`${LABEL_TODO}\`; this repository had no roadmap yet.`, ...minted.notices, ...this.#boundNotices(edit.body)] };
    }
    const edit = this.#applied(createTasks(chosen.body, input), parseRoadmap(chosen.body).tasks);
    await this.gh.run(["issue", "edit", String(chosen.number), "--body", edit.body]);
    const shift = this.#shift(edit.body, edit.value.shifted);
    return {
      issue: chosen.number,
      positions: edit.value.positions,
      ...shift.result,
      notices: [...this.#carrierNotices(carriers, chosen.number), ...shift.notices, ...this.#boundNotices(edit.body)],
    };
  }

  public async updateRoadmapTask(input: RoadmapUpdateInput): Promise<RoadmapWriteResult> {
    const carriers = await this.#scanTodoCarriers();
    const chosen = carriers[0];
    if (chosen === undefined) {
      throw new GitHubBoundaryError("missing-todo", `No open issue carries \`${LABEL_TODO}\`, so there is no task to update. Create the roadmap first with \`todo create\`.`);
    }
    const edit = this.#applied(updateTask(chosen.body, input), parseRoadmap(chosen.body).tasks);
    await this.gh.run(["issue", "edit", String(chosen.number), "--body", edit.body]);
    const shift = this.#shift(edit.body, edit.value.shifted);
    return {
      issue: chosen.number,
      task: edit.value.position,
      ...shift.result,
      notices: [...this.#carrierNotices(carriers, chosen.number), ...shift.notices, ...this.#boundNotices(edit.body)],
    };
  }

  #shift(body: string, shifted: boolean): { readonly result: { readonly tasks?: readonly string[] }; readonly notices: readonly string[] } {
    if (!shifted) return { result: {}, notices: [] };
    const pending = parseRoadmap(body).tasks.filter((task) => !task.completed);
    return {
      result: { tasks: numberedTasks(pending) },
      notices: ["This edit renumbered the tasks after it; `tasks` is the pending list as it now stands, and earlier positions you were holding are stale."],
    };
  }

  #applied<T>(edit: RoadmapEdit<T>, tasks: readonly RoadmapTask[]): { readonly body: string; readonly value: T } {
    if (edit.ok) return { body: edit.body, value: edit.value };
    if (edit.failure.reason === "invalid-subject") {
      throw new GitHubBoundaryError("invalid-subject", describeSubjectRejection(edit.failure.rejection), { subject: edit.failure.subject });
    }
    if (edit.failure.reason === "expectation-mismatch") {
      throw new GitHubBoundaryError(
        "expectation-mismatch",
        `Position ${edit.failure.position} is "${edit.failure.actual}", not "${edit.failure.expected}". Nothing was written. The roadmap changed since you last saw it, so re-read the list below and retry against the position the task holds now.`,
        { tasks: numberedTasks(tasks) },
      );
    }
    const field = edit.failure.field === "task" ? "No roadmap task is at position" : "No roadmap task is at the `after` position";
    throw new GitHubBoundaryError(
      "unknown-task",
      `${field} ${edit.failure.position}; the roadmap has ${tasks.length} task(s). Nothing was written. Use a position from the list below.`,
      { tasks: numberedTasks(tasks) },
    );
  }

  #boundNotices(body: string): readonly string[] {
    if (body.length > ROADMAP_BODY_LIMIT) return [`The roadmap is now ${body.length} characters, past the ${ROADMAP_BODY_LIMIT} bound. The write was accepted; ask the user whether to prune completed items.`];
    return nearBodyLimit(body) ? [`The roadmap is ${body.length} characters, near its ${ROADMAP_BODY_LIMIT} bound; consider asking the user about pruning.`] : [];
  }

  /** Reported, never repaired: aboard does not relabel an issue it does not own. */
  #carrierNotices(carriers: readonly { readonly number: number }[], chosen: number): readonly string[] {
    return carriers.length <= 1 ? [] : [`${carriers.length} open issues carry \`${LABEL_TODO}\`; #${chosen} is in use and the others were left untouched.`];
  }

  async #mintRoadmap(body: string): Promise<{ readonly number: number; readonly notices: readonly string[] }> {
    // Plain create, not `--force`: a user-owned `[AI]-todo` label keeps its colour
    // and description, and "already exists" is a success for our purposes.
    try { await this.gh.run(["label", "create", LABEL_TODO, "--description", "Project roadmap", "--color", "1D76DB"]); }
    catch { /* the label already exists, which is what we wanted anyway */ }
    const output = (await this.gh.run(["issue", "create", "--title", "Project roadmap", "--body", body, "--label", LABEL_TODO])).trim();
    const match = /\/issues\/(\d+)\/?$/.exec(output);
    if (match === null) throw new GitHubBoundaryError("malformed-output", "gh issue create did not return an issue URL");
    const number = integer(Number(match[1]), "created roadmap number");
    this.#minted = number;
    return { number, notices: await this.#pinRoadmap(number) };
  }

  async #pinRoadmap(number: number): Promise<readonly string[]> {
    try {
      await this.gh.run(["issue", "pin", String(number)]);
      return [];
    } catch {
      return [`Created the roadmap issue, but could not pin #${number}. The issue remains the \`${LABEL_TODO}\` carrier; pin it manually if you want it at the top of the repository issues page.`];
    }
  }

  public async getIssue(number: number): Promise<IssueSnapshot | undefined> {
    const repository = await this.#ownerRepo();
    let data: unknown;
    try {
      data = await this.#graphql(ISSUE_QUERY, { number });
    } catch (error) {
      if (error instanceof GitHubBoundaryError && error.code === "issue-not-found") return undefined;
      throw error;
    }
    const issue = repositoryFromGraphql(data).issue;
    if (issue === null) return undefined;
    const parsed = parseIssue(issue, "data.repository.issue", repository);
    const [remainingLabels, remainingSubIssues, remainingComments] = await Promise.all([
      this.#remainingLabels(number, parsed.nextLabelCursor),
      this.#remainingSubIssues(number, parsed.nextSubIssueCursor),
      this.#remainingComments(number, parsed.nextCommentCursor),
    ]);
    return {
      ...parsed.snapshot,
      labels: [...parsed.snapshot.labels, ...remainingLabels],
      comments: [...parsed.snapshot.comments, ...remainingComments],
      dependencyIssueNumbers: [...new Set([
        ...(parsed.snapshot.dependencyIssueNumbers ?? []),
        ...remainingSubIssues,
      ])],
    };
  }

  public async listRoadmapIssues(): Promise<readonly RoadmapIssue[]> {
    const page = await this.#scanOpenIssues();
    return page.rows.flatMap((row) => {
      if (hasLabel(row.labels, LABEL_TODO)) return [];
      return [{
        number: row.number,
        title: row.title,
        disposition: issueDisposition(row.labels),
        ready: row.openBlockedByNumbers.length === 0,
        dependencyNumbers: row.dependencyNumbers,
      }];
    });
  }

  public async listImplementableIssues(): Promise<ImplementableIssues> {
    const page = await this.#scanOpenIssues();
    return {
      candidates: page.rows.map((row) => ({
        number: row.number,
        title: row.title,
        labels: row.labels,
        state: "open" as const,
        openBlockedByNumbers: row.openBlockedByNumbers,
        dependencyNumbers: row.orderingDependencyNumbers,
        createdAt: row.createdAt,
      })),
    };
  }

  public async addIssueComment(number: number, body: string): Promise<void> {
    await this.gh.run(["issue", "comment", String(number), "--body", body]);
  }

  public async closeIssue(number: number, comment: string): Promise<void> {
    await this.gh.run(["issue", "close", String(number), "--reason", "completed", "--comment", comment]);
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<number> {
    const output = (await this.gh.run([
      "pr", "create", "--title", input.title, "--body", input.body, "--head", input.head, "--base", input.base,
    ])).trim();
    const match = /\/pull\/(\d+)\/?$/.exec(output);
    if (match === null) throw new GitHubBoundaryError("malformed-output", "gh pr create did not return a pull request URL");
    return integer(Number(match[1]), "created pull request number");
  }

  public async updatePullRequest(number: number, input: { readonly title: string; readonly body: string }): Promise<void> {
    await this.gh.run(["pr", "edit", String(number), "--title", input.title, "--body", input.body]);
  }

  public async findOpenPullRequestForBranch(branch: string): Promise<number | undefined> {
    const output = await this.gh.run(["pr", "list", "--state", "open", "--head", branch, "--limit", "1", "--json", "number"]);
    const items = array(json(output, "branch pull request lookup"), "branch pull request lookup");
    return items.length === 0 ? undefined : integer(record(items[0], "pull request").number, "pull request.number");
  }

  /** The newest pull request using this head branch, in any state. */
  public async findPullRequestForBranch(branch: string): Promise<number | undefined> {
    const output = await this.gh.run(["pr", "list", "--state", "all", "--head", branch, "--limit", "1", "--json", "number"]);
    const items = array(json(output, "branch pull request lookup"), "branch pull request lookup");
    return items.length === 0 ? undefined : integer(record(items[0], "pull request").number, "pull request.number");
  }

  /**
   * The newest pull request for each head branch, in any state, in one query —
   * the batched form of `findPullRequestForBranch` for plan-wide checks.
   */
  public async findPullRequestsByHead(branches: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const found = new Map<string, number>();
    const wanted = [...new Set(branches)];
    if (wanted.length === 0) return found;
    // A first:1 lookup per branch, aliased into a single GraphQL round trip.
    // Aliases must be GraphQL names, so the branch is carried as a variable.
    const fields = wanted.map((branch, index) =>
      `b${index}:pullRequests(headRefName:$h${index},first:1,states:[OPEN,CLOSED,MERGED],orderBy:{field:CREATED_AT,direction:DESC}){nodes{number}}`
    ).join(" ");
    const parameters = wanted.map((_branch, index) => `$h${index}:String!`).join(",");
    const variables = Object.fromEntries(wanted.map((branch, index) => [`h${index}`, branch]));
    const data = await this.#graphql(`query($owner:String!,$repo:String!,${parameters}){repository(owner:$owner,name:$repo){${fields}}}`, variables);
    const repository = repositoryFromGraphql(data);
    for (let index = 0; index < wanted.length; index += 1) {
      const nodes = array(record(repository[`b${index}`], `pull request lookup b${index}`).nodes, `pull request lookup b${index}.nodes`);
      if (nodes.length === 0) continue;
      found.set(wanted[index]!, integer(record(nodes[0], "pull request").number, "pull request.number"));
    }
    return found;
  }

  /** Pull requests whose head or base is one of the named branches, for destructive-cleanup previews. */
  public async listPullRequestsForBranches(branches: readonly string[]): Promise<readonly BranchPullRequest[]> {
    if (branches.length === 0) return [];
    const wanted = new Set(branches);
    const output = await this.gh.run(["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,title,state,headRefName,baseRefName"]);
    return array(json(output, "branch pull requests"), "branch pull requests").flatMap((value, index) => {
      const item = record(value, `branch pull request[${index}]`);
      const head = string(item.headRefName, `branch pull request[${index}].headRefName`);
      const base = string(item.baseRefName, `branch pull request[${index}].baseRefName`);
      if (!wanted.has(head) && !wanted.has(base)) return [];
      const rawState = string(item.state, `branch pull request[${index}].state`).toLowerCase();
      if (rawState !== "open" && rawState !== "closed" && rawState !== "merged") throw new GitHubBoundaryError("malformed-output", `branch pull request[${index}].state is unknown`);
      return [{ number: integer(item.number, `branch pull request[${index}].number`), title: string(item.title, `branch pull request[${index}].title`), state: rawState, head, base }];
    });
  }

  /** The most recently opened pull request still open, for `review_pr`. */
  public async findLatestOpenPullRequest(): Promise<number | undefined> {
    const output = await this.gh.run(["pr", "list", "--state", "open", "--limit", "1", "--json", "number"]);
    const items = array(json(output, "open pull request lookup"), "open pull request lookup");
    return items.length === 0 ? undefined : integer(record(items[0], "pull request").number, "pull request.number");
  }

  public async mergePullRequest(number: number, strategy: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void> {
    await this.gh.run(["pr", "merge", String(number), `--${strategy}`, ...(deleteBranch ? ["--delete-branch"] : [])]);
  }

  public async webUrl(number: number): Promise<string> {
    const { owner, repo } = await this.#ownerRepo();
    return `https://github.com/${owner}/${repo}/issues/${number}`;
  }

  public async closePullRequestIf(
    number: number,
    expected: { readonly head: string; readonly base: string },
  ): Promise<boolean> {
    const snapshot = await this.getPullRequest(number);
    if (snapshot === undefined || snapshot.state !== "open") return false;
    if (snapshot.headBranch !== expected.head || snapshot.baseBranch !== expected.base) return false;
    await this.gh.run(["pr", "close", String(number)]);
    return true;
  }

  public async getPullRequest(number: number): Promise<(PullRequestSnapshot & PullRequestMergeFacts) | undefined> {
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
      mergeable: mergeability(item.mergeable),
      url: string(item.url, "pullRequest.url"),
      headSha: string(item.headRefOid, "pullRequest.headRefOid"),
      reviewDecision: reviewDecision(item.reviewDecision, "pullRequest.reviewDecision"),
      ...(item.mergeCommit === null || item.mergeCommit === undefined
        ? {}
        : { mergeCommitSha: string(record(item.mergeCommit, "pullRequest.mergeCommit").oid, "pullRequest.mergeCommit.oid") }),
      ...(closing.length === 0 ? {} : { issueNumber: integer(record(closing[0], "closing issue").number, "closing issue.number") }),
    };
  }

  public async getPullRequestDiff(number: number): Promise<string> {
    return this.gh.run(["pr", "diff", String(number)]);
  }

  public async getReviewState(number: number): Promise<ReviewState> {
    const data = await this.#graphql(PR_QUERY, { number });
    const item = record(repositoryFromGraphql(data).pullRequest, "pullRequest");
    const decision = reviewDecision(item.reviewDecision, "pullRequest.reviewDecision");
    const threads = array(record(item.reviewThreads, "pullRequest.reviewThreads").nodes, "pullRequest.reviewThreads.nodes");
    return { decision, unresolvedThreadCount: threads.filter((thread, index) => !boolean(record(thread, `thread[${index}]`).isResolved, `thread[${index}].isResolved`)).length };
  }

  public async listOpenPullRequests(): Promise<readonly OpenPullRequest[]> {
    const output = await this.gh.run(["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,reviewDecision"]);
    return array(json(output, "open pull requests"), "open pull requests").map((value, index) => {
      const item = record(value, `open pull request[${index}]`);
      // `reviewDecision` is null until a review is requested or submitted, which
      // is the ordinary state of a freshly opened aboard pull request.
      const decision = item.reviewDecision === null || item.reviewDecision === undefined || item.reviewDecision === ""
        ? "no review yet"
        : string(item.reviewDecision, `open pull request[${index}].reviewDecision`).toLowerCase().replaceAll("_", " ");
      return {
        number: integer(item.number, `open pull request[${index}].number`),
        title: string(item.title, `open pull request[${index}].title`),
        reviewState: decision,
      };
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

  async #scanTodoCarriers(): Promise<readonly TodoCarrier[]> {
    const output = await this.gh.run(["issue", "list", "--state", "open", "--label", LABEL_TODO, "--limit", "50", "--json", "number,body,createdAt"]);
    const items = array(json(output, "roadmap lookup"), "roadmap lookup");
    const listed = items.map((value, index) => {
      const item = record(value, `roadmap issue[${index}]`);
      return {
        number: integer(item.number, `roadmap issue[${index}].number`),
        body: string(item.body ?? "", `roadmap issue[${index}].body`),
        createdAt: string(item.createdAt, `roadmap issue[${index}].createdAt`),
      };
    });
    return sortedCarriers(await this.#withMinted(listed));
  }

  async #withMinted(listed: readonly TodoCarrier[]): Promise<readonly TodoCarrier[]> {
    const minted = this.#minted;
    if (minted === undefined || listed.some((carrier) => carrier.number === minted)) return listed;
    const carrier = await this.#viewTodoCarrier(minted);
    if (carrier === undefined) {
      this.#minted = undefined;
      return listed;
    }
    return [...listed, carrier];
  }

  /** The minted issue as itself, or `undefined` once it stops being a carrier. */
  async #viewTodoCarrier(number: number): Promise<TodoCarrier | undefined> {
    let output: string;
    try {
      output = await this.gh.run(["issue", "view", String(number), "--json", "number,body,createdAt,state,labels"]);
    } catch {
      // The issue was deleted, or `gh` failed transiently. Either way the label
      // query stands on its own; a retry costs one more lookup.
      return undefined;
    }
    const item = record(json(output, "roadmap issue lookup"), "roadmap issue lookup");
    if (state(item.state, "roadmap issue lookup.state") !== "open") return undefined;
    if (!hasLabel(labels(item.labels, "roadmap issue lookup.labels"), LABEL_TODO)) return undefined;
    return {
      number: integer(item.number, "roadmap issue lookup.number"),
      body: string(item.body ?? "", "roadmap issue lookup.body"),
      createdAt: string(item.createdAt, "roadmap issue lookup.createdAt"),
    };
  }

  async #scanOpenIssues(): Promise<{ readonly rows: readonly OpenIssueRow[] }> {
    const rows = new Map<number, OpenIssueRow>();
    const repository = await this.#ownerRepo();
    let cursor: string | undefined;
    do {
      const data = await this.#graphql(OPEN_ISSUES_QUERY, cursor === undefined ? {} : { after: cursor });
      const issues = record(repositoryFromGraphql(data).issues, "data.repository.issues");
      const nodes = array(issues.nodes, "data.repository.issues.nodes");
      const parsed = nodes.map((value, index) => parseOpenIssue(value, `issues[${index}]`, repository));
      for (const issue of await Promise.all(parsed.map((entry) => this.#completeOpenIssue(entry)))) {
        rows.set(issue.number, issue);
      }
      const nextCursor = pageInfo(issues.pageInfo, "data.repository.issues.pageInfo").nextCursor;
      if (nextCursor !== undefined && nextCursor === cursor) {
        throw new GitHubBoundaryError("malformed-output", "data.repository.issues.pageInfo did not advance its cursor");
      }
      cursor = nextCursor;
    } while (cursor !== undefined);
    return { rows: [...rows.values()] };
  }

  async #completeOpenIssue(parsed: ParsedOpenIssue): Promise<OpenIssueRow> {
    const [labels, dependencies, subIssues] = await Promise.all([
      this.#remainingLabels(parsed.row.number, parsed.nextLabelCursor),
      this.#remainingDependencies(parsed.row.number, parsed.nextDependencyCursor),
      this.#remainingSubIssues(parsed.row.number, parsed.nextSubIssueCursor),
    ]);
    const allLabels = [...new Set([...parsed.row.labels, ...labels])];
    const byNumber = new Map(parsed.dependencies.map((dependency) => [dependency.number, dependency]));
    for (const dependency of dependencies) byNumber.set(dependency.number, dependency);
    const allDependencies = [...byNumber.values()];
    const allSubIssues = [...new Set([...parsed.subIssueNumbers, ...subIssues])];
    return {
      ...parsed.row,
      labels: allLabels,
      dependencyNumbers: allDependencies.map((dependency) => dependency.number),
      openBlockedByNumbers: allDependencies.flatMap((dependency) => dependency.state === "open" ? [dependency.number] : []),
      orderingDependencyNumbers: [...new Set([
        ...allDependencies.map((dependency) => dependency.number),
        ...allSubIssues,
        ...parsed.row.orderingDependencyNumbers,
      ])],
    };
  }

  async #remainingLabels(number: number, initialCursor: string | undefined): Promise<readonly string[]> {
    const found: string[] = [];
    let cursor = initialCursor;
    while (cursor !== undefined) {
      const data = await this.#graphql(ISSUE_LABELS_QUERY, { number, after: cursor });
      const issue = repositoryFromGraphql(data).issue;
      if (issue === null || issue === undefined) break;
      const page = parseLabelPage(record(issue, "data.repository.issue").labels, "data.repository.issue.labels");
      found.push(...page.labels);
      if (page.nextCursor !== undefined && page.nextCursor === cursor) {
        throw new GitHubBoundaryError("malformed-output", "data.repository.issue.labels.pageInfo did not advance its cursor");
      }
      cursor = page.nextCursor;
    }
    return found;
  }

  async #remainingDependencies(number: number, initialCursor: string | undefined): Promise<readonly Dependency[]> {
    const found: Dependency[] = [];
    let cursor = initialCursor;
    while (cursor !== undefined) {
      const data = await this.#graphql(ISSUE_BLOCKERS_QUERY, { number, after: cursor });
      const issue = repositoryFromGraphql(data).issue;
      if (issue === null || issue === undefined) break;
      const page = parseDependencyPage(record(issue, "data.repository.issue").blockedBy, "data.repository.issue.blockedBy");
      found.push(...page.dependencies);
      if (page.nextCursor !== undefined && page.nextCursor === cursor) {
        throw new GitHubBoundaryError("malformed-output", "data.repository.issue.blockedBy.pageInfo did not advance its cursor");
      }
      cursor = page.nextCursor;
    }
    return found;
  }

  async #remainingSubIssues(number: number, initialCursor: string | undefined): Promise<readonly number[]> {
    const found: number[] = [];
    let cursor = initialCursor;
    while (cursor !== undefined) {
      const data = await this.#graphql(ISSUE_SUBISSUES_QUERY, { number, after: cursor });
      const issue = repositoryFromGraphql(data).issue;
      if (issue === null || issue === undefined) break;
      const page = parseIssueNumberPage(record(issue, "data.repository.issue").subIssues, "data.repository.issue.subIssues");
      found.push(...page.numbers);
      if (page.nextCursor !== undefined && page.nextCursor === cursor) {
        throw new GitHubBoundaryError("malformed-output", "data.repository.issue.subIssues.pageInfo did not advance its cursor");
      }
      cursor = page.nextCursor;
    }
    return found;
  }

  async #remainingComments(number: number, initialCursor: string | undefined): Promise<IssueSnapshot["comments"]> {
    const found: IssueCommentSnapshot[] = [];
    let cursor = initialCursor;
    while (cursor !== undefined) {
      const data = await this.#graphql(ISSUE_COMMENTS_QUERY, { number, after: cursor });
      const issue = repositoryFromGraphql(data).issue;
      if (issue === null || issue === undefined) break;
      const page = parseIssueCommentPage(record(issue, "data.repository.issue").comments, "data.repository.issue.comments");
      found.push(...page.comments);
      if (page.nextCursor !== undefined && page.nextCursor === cursor) {
        throw new GitHubBoundaryError("malformed-output", "data.repository.issue.comments.pageInfo did not advance its cursor");
      }
      cursor = page.nextCursor;
    }
    return found;
  }

  async #ownerRepo(): Promise<{ readonly owner: string; readonly repo: string }> {
    this.#identity ??= this.#resolveOwnerRepo().catch((error: unknown) => {
      // A failed lookup must not be cached, or a transient `gh` outage would
      // poison every later query for the life of the extension host.
      this.#identity = undefined;
      throw error;
    });
    return this.#identity;
  }

  async #resolveOwnerRepo(): Promise<{ readonly owner: string; readonly repo: string }> {
    const ownerRepo = record(json(await this.gh.run(["repo", "view", "--json", "owner,name"]), "repository identity"), "repository identity");
    const owner = record(ownerRepo.owner, "repository owner");
    return { owner: string(owner.login, "repository owner.login"), repo: string(ownerRepo.name, "repository name") };
  }

  async #graphql(query: string, variables: Readonly<Record<string, number | string>> = {}): Promise<unknown> {
    const { owner, repo } = await this.#ownerRepo();
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`];
    for (const [key, value] of Object.entries(variables)) {
      args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    }
    return json(await this.gh.run(args), "GitHub GraphQL");
  }
}
