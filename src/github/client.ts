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
import { LABEL_HITL, LABEL_SPEC, LABEL_TODO, issueDisposition } from "../shared/labels.js";

export { ABOARD_LABELS } from "../shared/labels.js";
export type { AboardLabel } from "../shared/labels.js";

const execFileAsync = promisify(execFile);

export type GitHubErrorCode =
  | "command-failed"
  | "malformed-output"
  | "missing-todo"
  | "unknown-task"
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
  /** Ids of the tasks the call created, in the order their subjects were given. */
  readonly ids?: readonly string[];
  /** The edited task's current id, absent when it was deleted. */
  readonly task?: string | undefined;
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

export interface SpecIssue {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
}

/** A `spec` issue's child, with just what selection needs (`AGENTS.md`). */
export interface SubIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  readonly openBlockedByNumbers: readonly number[];
}

export interface CreatePullRequestInput {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
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
const SPEC_QUERY = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(first:100,states:OPEN,labels:["${LABEL_SPEC}"],orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title createdAt}}}}`;
const SUB_ISSUE_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){subIssues(first:100){nodes{number title state labels(first:20){nodes{name}} blockedBy(first:100){nodes{number state}}}}}}}`;
const ROADMAP_QUERY = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(first:100,states:OPEN){nodes{number title labels(first:20){nodes{name}} blockedBy(first:100){nodes{number state}}}}}}`;
const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number title body state merged headRefName baseRefName headRefOid closingIssuesReferences(first:10){nodes{number}} reviewDecision reviewThreads(first:100){nodes{isResolved}}}}}`;
const THREAD_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line comments(first:100){nodes{body author{login}}}}}}}}`;

export class GitHubClient implements GitHubPromptSource {
  #identity: Promise<{ readonly owner: string; readonly repo: string }> | undefined;

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
      const number = await this.#mintRoadmap(edit.body);
      return { issue: number, ids: edit.value, notices: [`Created issue #${number} and labelled it \`${LABEL_TODO}\`; this repository had no roadmap yet.`, ...this.#boundNotices(edit.body)] };
    }
    const edit = this.#applied(createTasks(chosen.body, input), parseRoadmap(chosen.body).tasks);
    await this.gh.run(["issue", "edit", String(chosen.number), "--body", edit.body]);
    return { issue: chosen.number, ids: edit.value, notices: [...this.#carrierNotices(carriers, chosen.number), ...this.#boundNotices(edit.body)] };
  }

  public async updateRoadmapTask(input: RoadmapUpdateInput): Promise<RoadmapWriteResult> {
    const carriers = await this.#scanTodoCarriers();
    const chosen = carriers[0];
    if (chosen === undefined) {
      throw new GitHubBoundaryError("missing-todo", `No open issue carries \`${LABEL_TODO}\`, so there is no task to update. Create the roadmap first with \`todo create\`.`);
    }
    const edit = this.#applied(updateTask(chosen.body, input), parseRoadmap(chosen.body).tasks);
    await this.gh.run(["issue", "edit", String(chosen.number), "--body", edit.body]);
    return { issue: chosen.number, task: edit.value, notices: [...this.#carrierNotices(carriers, chosen.number), ...this.#boundNotices(edit.body)] };
  }

  /**
   * Turns a rejected edit into a typed failure. An unknown id carries the
   * current numbered list, because that is exactly the data a retry needs and
   * the situation is rare by construction — the alternative, matching a subject
   * fuzzily, writes silently to the wrong task when it guesses wrong.
   */
  #applied<T>(edit: RoadmapEdit<T>, tasks: readonly RoadmapTask[]): { readonly body: string; readonly value: T } {
    if (edit.ok) return { body: edit.body, value: edit.value };
    if (edit.failure.reason === "invalid-subject") {
      throw new GitHubBoundaryError("invalid-subject", describeSubjectRejection(edit.failure.rejection), { subject: edit.failure.subject });
    }
    throw new GitHubBoundaryError(
      "unknown-task",
      `No roadmap task has id ${edit.failure.id}. Ids are derived from the subject text, so editing a subject changes its id; copy one from the list below.`,
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

  async #mintRoadmap(body: string): Promise<number> {
    // Plain create, not `--force`: a user-owned `ai:todo` label keeps its colour
    // and description, and "already exists" is a success for our purposes.
    try { await this.gh.run(["label", "create", LABEL_TODO, "--description", "Project roadmap", "--color", "1D76DB"]); }
    catch { /* the label already exists, which is what we wanted anyway */ }
    const output = (await this.gh.run(["issue", "create", "--title", "Project roadmap", "--body", body, "--label", LABEL_TODO])).trim();
    const match = /\/issues\/(\d+)\/?$/.exec(output);
    if (match === null) throw new GitHubBoundaryError("malformed-output", "gh issue create did not return an issue URL");
    return integer(Number(match[1]), "created roadmap number");
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
      if (issueLabels.some((label) => label.toLowerCase() === LABEL_SPEC || label.toLowerCase() === LABEL_TODO)) return [];
      const dependencies = array(record(item.blockedBy, `issues[${index}].blockedBy`).nodes, `issues[${index}].blockedBy.nodes`);
      return [{
        number: integer(item.number, `issues[${index}].number`),
        title: string(item.title, `issues[${index}].title`),
        disposition: issueDisposition(issueLabels),
        ready: dependencies.every((dependency, dependencyIndex) => state(record(dependency, `dependency[${dependencyIndex}]`).state, `dependency[${dependencyIndex}].state`) === "closed"),
        dependencyNumbers: dependencies.map((dependency, dependencyIndex) => integer(record(dependency, `dependency[${dependencyIndex}]`).number, `dependency[${dependencyIndex}].number`)),
      }];
    });
  }

  /**
   * Open `spec` issues, oldest first by creation. "Oldest" is by `createdAt` and
   * not by `updatedAt`: a spec being edited is not a spec being deprioritized.
   * Ties break on the lower number.
   */
  public async listSpecIssues(): Promise<readonly SpecIssue[]> {
    const data = await this.#graphql(SPEC_QUERY);
    const nodes = array(record(repositoryFromGraphql(data).issues, "data.repository.issues").nodes, "data.repository.issues.nodes");
    return nodes
      .map((value, index) => {
        const item = record(value, `spec[${index}]`);
        return {
          number: integer(item.number, `spec[${index}].number`),
          title: string(item.title, `spec[${index}].title`),
          createdAt: string(item.createdAt, `spec[${index}].createdAt`),
        };
      })
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.number - right.number);
  }

  /** A spec's children through the GraphQL sub-issue edge, ascending by number. */
  public async listSubIssues(parentNumber: number): Promise<readonly SubIssue[]> {
    const data = await this.#graphql(SUB_ISSUE_QUERY, { number: parentNumber });
    const issue = repositoryFromGraphql(data).issue;
    if (issue === null || issue === undefined) return [];
    const nodes = array(record(record(issue, "issue").subIssues, "issue.subIssues").nodes, "issue.subIssues.nodes");
    return nodes
      .map((value, index) => {
        const item = record(value, `subIssue[${index}]`);
        const dependencies = item.blockedBy === undefined || item.blockedBy === null
          ? []
          : array(record(item.blockedBy, `subIssue[${index}].blockedBy`).nodes, `subIssue[${index}].blockedBy.nodes`);
        return {
          number: integer(item.number, `subIssue[${index}].number`),
          title: string(item.title, `subIssue[${index}].title`),
          labels: labels(record(item.labels, `subIssue[${index}].labels`).nodes, `subIssue[${index}].labels.nodes`),
          state: state(item.state, `subIssue[${index}].state`),
          openBlockedByNumbers: dependencies.flatMap((dependency, dependencyIndex) => {
            const entry = record(dependency, `subIssue[${index}].blockedBy[${dependencyIndex}]`);
            return state(entry.state, `subIssue[${index}].blockedBy[${dependencyIndex}].state`) === "open"
              ? [integer(entry.number, `subIssue[${index}].blockedBy[${dependencyIndex}].number`)]
              : [];
          }),
        };
      })
      .sort((left, right) => left.number - right.number);
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

  public async mergePullRequest(number: number, strategy: "squash" | "merge" | "rebase"): Promise<void> {
    await this.gh.run(["pr", "merge", String(number), `--${strategy}`, "--delete-branch"]);
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
  async #scanTodoCarriers(): Promise<readonly { readonly number: number; readonly body: string; readonly createdAt: string }[]> {
    const output = await this.gh.run(["issue", "list", "--state", "open", "--label", LABEL_TODO, "--limit", "50", "--json", "number,body,createdAt"]);
    const items = array(json(output, "roadmap lookup"), "roadmap lookup");
    return items
      .map((value, index) => {
        const item = record(value, `roadmap issue[${index}]`);
        return {
          number: integer(item.number, `roadmap issue[${index}].number`),
          body: string(item.body ?? "", `roadmap issue[${index}].body`),
          createdAt: string(item.createdAt, `roadmap issue[${index}].createdAt`),
        };
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.number - right.number);
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

  async #graphql(query: string, variables: Readonly<Record<string, number>> = {}): Promise<unknown> {
    const { owner, repo } = await this.#ownerRepo();
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`];
    for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);
    return json(await this.gh.run(args), "GitHub GraphQL");
  }
}
