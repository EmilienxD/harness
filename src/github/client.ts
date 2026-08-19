import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  GitHubPromptSource,
  IssueSnapshot,
  PullRequestSnapshot,
  ReviewThreadSnapshot,
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
import { LABEL_HITL, LABEL_SPEC, LABEL_TODO, hasLabel, issueDisposition } from "../shared/labels.js";

export { ABOARD_LABELS } from "../shared/labels.js";
export type { AboardLabel } from "../shared/labels.js";

const execFileAsync = promisify(execFile);

export type GitHubErrorCode =
  | "command-failed"
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

/**
 * The roadmap issue as one label query returns it. `carrierCount` is reported,
 * never repaired: aboard does not modify an issue it did not create, so extra
 * carriers become inert rather than ambiguous.
 */
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
  /**
   * The current pending list, present only when the edit renumbered other tasks.
   * An append or an in-place edit shifts nothing and omits it, which keeps the
   * common call cheap.
   */
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

/**
 * What auto-run needs about a pull request beyond the prompt-facing snapshot:
 * whether it can be merged at all, and where to send the user when it cannot.
 */
export interface PullRequestMergeFacts {
  /**
   * GitHub's own verdict. `unknown` is an answer rather than a parse failure —
   * mergeability is computed by a background job, so a pull request whose head
   * was just pushed reports `UNKNOWN` until that job lands.
   */
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
  readonly url: string;
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
  readonly totalCount: number;
}

function parseIssueNumberPage(value: unknown, context: string): IssueNumberPage {
  if (value === undefined || value === null) {
    return { numbers: [], totalCount: 0, nextCursor: undefined };
  }
  const connection = record(value, context);
  const nodes = connection.nodes === undefined ? [] : array(connection.nodes, `${context}.nodes`);
  const numbers = nodes.map((node, index) =>
    integer(record(node, `${context}.nodes[${index}]`).number, `${context}.nodes[${index}].number`));
  const totalCount = Number.isInteger(connection.totalCount) && (connection.totalCount as number) >= 0
    ? connection.totalCount as number
    : numbers.length;
  const paging = connection.pageInfo === undefined
    ? { nextCursor: undefined }
    : pageInfo(connection.pageInfo, `${context}.pageInfo`);
  return { numbers, totalCount, nextCursor: paging.nextCursor };
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
}

function parseIssue(
  value: unknown,
  context: string,
  repository: { readonly owner: string; readonly repo: string },
): ParsedIssue {
  const item = record(value, context);
  const labelPage = parseLabelPage(item.labels, `${context}.labels`);
  const subIssuePage = parseIssueNumberPage(item.subIssues, `${context}.subIssues`);
  const parent = item.parent === null || item.parent === undefined
    ? undefined
    : integer(record(item.parent, `${context}.parent`).number, `${context}.parent.number`);
  const branches = item.closedByPullRequestsReferences === undefined
    ? []
    : array(record(item.closedByPullRequestsReferences, `${context}.closedByPullRequestsReferences`).nodes, `${context}.closedByPullRequestsReferences.nodes`);
  const branch = branches.length === 0
    ? undefined
    : string(record(branches[0], `${context}.closedByPullRequestsReferences.nodes[0]`).headRefName, `${context}.closedByPullRequestsReferences.nodes[0].headRefName`);
  const body = string(item.body ?? "", `${context}.body`);
  return {
    snapshot: {
      number: integer(item.number, `${context}.number`),
      title: string(item.title, `${context}.title`),
      body,
      labels: labelPage.labels,
      state: state(item.state, `${context}.state`),
      ...(parent === undefined ? {} : { parentIssueNumber: parent }),
      dependencyIssueNumbers: [...new Set([
        ...subIssuePage.numbers,
        ...referencedIssueNumbers(body, repository),
      ])],
      ...(branch === undefined ? {} : { branch }),
    },
    nextLabelCursor: labelPage.nextCursor,
    nextSubIssueCursor: subIssuePage.nextCursor,
  };
}

/** One row of the open-issue page, parsed once and projected two ways. */
interface OpenIssueRow {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly labels: readonly string[];
  readonly hasChildren: boolean;
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
      hasChildren: subIssuePage.totalCount > 0,
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

const ISSUE_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){number title body state labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}} parent{number} subIssues(first:100){nodes{number} totalCount pageInfo{hasNextPage endCursor}} closedByPullRequestsReferences(first:1){nodes{headRefName}}}}}`;
/**
 * Open issues, oldest first, carrying everything both read paths need. Every
 * connection exposes its cursor: the top-level queue is fully paginated, and
 * the normally single-page label/dependency connections are completed by
 * focused follow-up queries when GitHub says another page exists.
 */
const OPEN_ISSUES_QUERY = `query($owner:String!,$repo:String!,$after:String){repository(owner:$owner,name:$repo){issues(first:100,after:$after,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title body createdAt labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}} subIssues(first:100){nodes{number} totalCount pageInfo{hasNextPage endCursor}} blockedBy(first:100){nodes{number state} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}`;
const ISSUE_LABELS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){issue(number:$number){labels(first:100,after:$after){nodes{name} pageInfo{hasNextPage endCursor}}}}}`;
const ISSUE_BLOCKERS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){issue(number:$number){blockedBy(first:100,after:$after){nodes{number state} pageInfo{hasNextPage endCursor}}}}}`;
const ISSUE_SUBISSUES_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){issue(number:$number){subIssues(first:100,after:$after){nodes{number} totalCount pageInfo{hasNextPage endCursor}}}}}`;
const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number title body state merged mergeable url headRefName baseRefName headRefOid closingIssuesReferences(first:10){nodes{number}} reviewDecision reviewThreads(first:100){nodes{isResolved}}}}}`;
const THREAD_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line comments(first:100){nodes{body author{login}}}}}}}}`;

export class GitHubClient implements GitHubPromptSource {
  #identity: Promise<{ readonly owner: string; readonly repo: string }> | undefined;

  /**
   * The roadmap issue this process minted, if any. `gh issue list --label` reads
   * an index that lags creation by seconds, so the issue `todo_create` just made
   * can be absent from the very next resolution — which is how a `todo_create`
   * followed immediately by `todo_update` failed with `missing-todo` against an
   * issue that already existed, costing the Manager a wasted call and a retry.
   *
   * This is not the rejected number cache: it holds only aboard's own write, it
   * saves no round trip on the common path, and it is never trusted on its own.
   * When the label query comes back without it, the issue is read directly by
   * number — a point lookup is consistent where the list is not — and the seed
   * is dropped the moment that read says it is closed, unlabelled, or gone.
   */
  #minted: number | undefined;

  public constructor(private readonly gh: GhExecutor) {}

  /**
   * Proves the capability auto-run actually needs: the active gh account can
   * authenticate to and resolve this workspace's repository. The probe always
   * runs: a cached repository identity must not hide that the user logged out.
   * Its successful identity is reused by the next GraphQL query, avoiding an
   * extra subprocess and an all-host `gh auth status` false failure.
   */
  public async checkAuthentication(): Promise<void> {
    const identity = await this.#resolveOwnerRepo();
    this.#identity = Promise.resolve(identity);
  }

  /**
   * The roadmap, or `undefined` when no open issue carries the label — the
   * ordinary first-run state of a repository, distinct from a failed fetch.
   *
   * One query answers both halves of the question: `--json number,body` returns
   * the locator *and* the document, so there is nothing a cached number could
   * have saved. The previous session cache saved zero round trips, because
   * every use of it had to revalidate and revalidation costs exactly what
   * resolving from scratch costs.
   */
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

  /**
   * Appends tasks, minting the roadmap issue when no carrier exists. Minting is
   * the only creation path and happens only here: `updateTask` against an empty
   * candidate set is a failure, because there is no document its id could name.
   */
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

  /**
   * An edit that renumbered other tasks hands back the current pending list, so
   * the caller's next address is right the first time rather than after a guard
   * failure teaches it so. Completed tasks are omitted: they are the bulk of a
   * mature roadmap and are almost never the target of a follow-up edit.
   */
  #shift(body: string, shifted: boolean): { readonly result: { readonly tasks?: readonly string[] }; readonly notices: readonly string[] } {
    if (!shifted) return { result: {}, notices: [] };
    const pending = parseRoadmap(body).tasks.filter((task) => !task.completed);
    return {
      result: { tasks: numberedTasks(pending) },
      notices: ["This edit renumbered the tasks after it; `tasks` is the pending list as it now stands, and earlier positions you were holding are stale."],
    };
  }

  /**
   * Turns a rejected edit into a typed failure. Both addressing failures carry
   * the current list, because that is exactly the data a retry needs and it
   * costs one already-fetched parse — the alternative, matching a subject
   * fuzzily, writes silently to the wrong task when it guesses wrong.
   */
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

  /**
   * The bound is advisory. A one-sentence `create` that crosses it means the
   * roadmap was already there, and deletion needs the user's explicit request,
   * so refusing the write would deadlock the Manager with no way out.
   */
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
    // Seed the resolver before returning: the caller's next roadmap operation is
    // typically the immediate follow-up write, which is exactly when the label
    // index has not caught up with this creation.
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
    const data = await this.#graphql(ISSUE_QUERY, { number });
    const issue = repositoryFromGraphql(data).issue;
    if (issue === null) return undefined;
    const parsed = parseIssue(issue, "data.repository.issue", repository);
    const [remainingLabels, remainingSubIssues] = await Promise.all([
      this.#remainingLabels(number, parsed.nextLabelCursor),
      this.#remainingSubIssues(number, parsed.nextSubIssueCursor),
    ]);
    return {
      ...parsed.snapshot,
      labels: [...parsed.snapshot.labels, ...remainingLabels],
      dependencyIssueNumbers: [...new Set([
        ...(parsed.snapshot.dependencyIssueNumbers ?? []),
        ...remainingSubIssues,
      ])],
    };
  }

  /**
   * The briefing's ready/blocked list. `[AI]-spec` and `[AI]-todo` carriers are
   * dropped: the roadmap is rendered separately and a spec is an umbrella, not
   * a task. Oldest first, which reads as priority.
   */
  public async listRoadmapIssues(): Promise<readonly RoadmapIssue[]> {
    const page = await this.#scanOpenIssues();
    return page.rows.flatMap((row) => {
      if (hasLabel(row.labels, LABEL_SPEC) || hasLabel(row.labels, LABEL_TODO)) return [];
      return [{
        number: row.number,
        title: row.title,
        disposition: issueDisposition(row.labels),
        ready: row.openBlockedByNumbers.length === 0,
        dependencyNumbers: row.dependencyNumbers,
      }];
    });
  }

  /**
   * The auto-run graph: every open issue and its inferred ordering edges,
   * projected into the domain's candidate shape. Selection — dispositions,
   * umbrellas, blocking, sorting — happens in `selectIssues`, so this boundary
   * reports and never judges.
   */
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
        hasChildren: row.hasChildren,
      })),
    };
  }

  /**
   * Posts a comment on an issue. Used by auto-run to leave the implementer's own
   * account of the change where the issue's readers are, rather than only on the
   * pull request that will be squashed away.
   */
  public async addIssueComment(number: number, body: string): Promise<void> {
    await this.gh.run(["issue", "comment", String(number), "--body", body]);
  }

  /**
   * Closes an issue as completed. Auto-run needs this because GitHub only acts
   * on a `Closes #N` keyword when the pull request merges into the default
   * branch, and aboard's pull requests merge into a run's session branch. The
   * comment is posted with the closure so the issue says who closed it and why.
   */
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

  /**
   * The open pull request whose head is this branch, if any. This is the `pr`
   * phase's postcondition, so it must answer from the repository rather than
   * from the run record.
   */
  public async findOpenPullRequestForBranch(branch: string): Promise<number | undefined> {
    const output = await this.gh.run(["pr", "list", "--state", "open", "--head", branch, "--limit", "1", "--json", "number"]);
    const items = array(json(output, "branch pull request lookup"), "branch pull request lookup");
    return items.length === 0 ? undefined : integer(record(items[0], "pull request").number, "pull request.number");
  }

  /** The most recently opened pull request still open, for `review_pr`. */
  public async findLatestOpenPullRequest(): Promise<number | undefined> {
    const output = await this.gh.run(["pr", "list", "--state", "open", "--limit", "1", "--json", "number"]);
    const items = array(json(output, "open pull request lookup"), "open pull request lookup");
    return items.length === 0 ? undefined : integer(record(items[0], "pull request").number, "pull request.number");
  }

  /**
   * `deleteBranch` is a caller's decision because deleting a base branch closes
   * every open pull request still targeting it. An issue branch has no such
   * dependents and is deleted; a run's session branch is the base of any parked
   * or unmerged issue pull request, so it is kept.
   */
  public async mergePullRequest(number: number, strategy: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void> {
    await this.gh.run(["pr", "merge", String(number), `--${strategy}`, ...(deleteBranch ? ["--delete-branch"] : [])]);
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

  /**
   * Open issues carrying the roadmap label, newest first and ties on the lowest
   * number. Read and write resolve through this one rule, so they converge on
   * the same issue with no mutation and no healing pass.
   *
   * There is deliberately no `--search sort:created-desc`. Passing `--search`
   * moves the query off the deterministic label filter onto GitHub's
   * asynchronously indexed search API, where an issue created seconds ago can be
   * missing — which would mint a duplicate roadmap. The sort is done here.
   */
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

  /**
   * Adds the issue this process minted back to a candidate set the index has
   * not caught up with yet, at the cost of one point lookup and only while the
   * lag lasts. The lookup is authoritative in both directions: it supplies the
   * current body rather than the one aboard wrote (the user may have edited the
   * issue meanwhile), and a closed, unlabelled, or deleted issue clears the seed
   * instead of resurrecting a roadmap the repository no longer has.
   */
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

  /**
   * The one open-issue read. Both public projections are built from this, so
   * the briefing and the auto-run queue cannot disagree about what is open,
   * what blocks it, or what order it is in.
   */
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

  /**
   * The repository's identity does not change for the lifetime of a workspace,
   * and every GraphQL call needs it. Resolving it per call meant an extra `gh`
   * subprocess on every query, which the auto-run loop makes several of per
   * phase and once per poll tick while a hitl pull request waits.
   */
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
