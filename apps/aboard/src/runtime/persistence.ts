import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUTO_RUN_BRANCH_MODES, AUTO_RUN_PHASES, DEFAULT_ISSUE_CONTEXT_DEPTH, MAX_ISSUE_CONTEXT_DEPTH, MERGE_STRATEGIES, type AutoRunBranchMode, type AutoRunPhase, type IssueDisposition, type MergeStrategy } from "../domain/auto-run.js";
import {
  RUN_CHECKPOINTS,
  type AutoRunRecord,
  type FrozenIssue,
  type FrozenRunSettings,
  type IssueProgress,
  type PendingAction,
  type PersistedAutoRunRecord,
  type RunAttemptOutcome,
  type RunCheckpoint,
} from "../domain/run-plan.js";
import type { ActivityDto } from "../domain/activity.js";
import type { FleetPersistenceDto } from "../domain/fleet.js";
import type { AgentId, SessionId } from "../domain/contracts.js";
import { parseActivityDto, parseFleetPersistenceDto } from "../domain/validation.js";
import { ISSUE_DIFFICULTIES, type IssueDifficulty } from "../shared/labels.js";
import type { RuntimeAdmission } from "./admission.js";
import type { RuntimeLayout } from "./layout.js";

export class AtomicJsonFile<T> {
  public constructor(private readonly path: string, private readonly parse: (value: unknown) => T | undefined, private readonly admission?: RuntimeAdmission) {}
  public async load(): Promise<T | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return this.parse(value);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  public async save(value: T): Promise<void> {
    if (this.admission !== undefined) return this.admission.run(() => this.write(value));
    return this.write(value);
  }
  private async write(value: T): Promise<void> {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rm(this.path, { force: true });
    await rename(temporary, this.path);
  }
  public async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export class FileFleetStore extends AtomicJsonFile<FleetPersistenceDto> {
  public constructor(runtimeRoot: string, admission?: RuntimeAdmission) {
    super(join(runtimeRoot, "state", "fleet.json"), (value) => {
      const result = parseFleetPersistenceDto(value);
      return result.ok ? result.value : undefined;
    }, admission);
  }
}

export class FileActivityStore extends AtomicJsonFile<ActivityDto> {
  public constructor(runtimeRoot: string, admission?: RuntimeAdmission) {
    super(join(runtimeRoot, "state", "activity.json"), (value) => {
      const result = parseActivityDto(value);
      return result.ok ? result.value : undefined;
    }, admission);
  }

  public async clear(): Promise<void> {
    await this.remove();
  }
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function fullSha(value: unknown): string | undefined {
  return typeof value === "string" && (value.length === 40 || value.length === 64) && !/\s/u.test(value) ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function disposition(value: unknown): IssueDisposition | undefined {
  return value === "afk" || value === "hitl" ? value : undefined;
}

function difficulty(value: unknown): IssueDifficulty | undefined {
  return (ISSUE_DIFFICULTIES as readonly string[]).includes(value as string) ? value as IssueDifficulty : undefined;
}

function numbers(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(positiveInteger);
  return parsed.some((number) => number === undefined) ? undefined : parsed as number[];
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? value as string[] : undefined;
}

function isDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_ISSUE_CONTEXT_DEPTH;
}

function parseFrozenSettings(value: unknown): FrozenRunSettings | undefined {
  if (!isRecord(value)) return undefined;
  const worktree = isRecord(value.worktree) ? value.worktree : undefined;
  if (worktree === undefined) return undefined;
  const mergeStrategy = (MERGE_STRATEGIES as readonly string[]).includes(value.mergeStrategy as string)
    ? value.mergeStrategy as MergeStrategy
    : undefined;
  if (
    typeof value.review !== "boolean"
    || (value.exploreBeforeImplement !== undefined && typeof value.exploreBeforeImplement !== "boolean")
    || (value.issueContextDepth !== undefined && !isDepth(value.issueContextDepth))
    || typeof value.mergeRunPullRequest !== "boolean" || typeof value.pauseAfterHitl !== "boolean"
    || mergeStrategy === undefined
    || typeof worktree.enabled !== "boolean" || typeof worktree.root !== "string"
    || typeof worktree.keep !== "boolean" || positiveInteger(worktree.setupTimeoutSeconds) === undefined
  ) return undefined;
  const permanentPrompt = nonEmptyString(value.permanentPrompt)?.trim();
  const guideline = nonEmptyString(value.additionalGuideline)?.trim();
  if (
    (value.permanentPrompt !== undefined && permanentPrompt === undefined)
    || (value.additionalGuideline !== undefined && guideline === undefined)
  ) return undefined;
  const branchMode = (AUTO_RUN_BRANCH_MODES as readonly string[]).includes(value.branchMode as string) ? value.branchMode as AutoRunBranchMode : undefined;
  if (value.branchMode !== undefined && branchMode === undefined) return undefined;
  return {
    ...(branchMode === undefined ? {} : { branchMode }),
    review: value.review,
    exploreBeforeImplement: value.exploreBeforeImplement ?? false,
    issueContextDepth: value.issueContextDepth ?? DEFAULT_ISSUE_CONTEXT_DEPTH,
    mergeStrategy,
    mergeRunPullRequest: value.mergeRunPullRequest,
    pauseAfterHitl: value.pauseAfterHitl,
    worktree: {
      enabled: worktree.enabled,
      root: worktree.root,
      keep: worktree.keep,
      setupTimeoutSeconds: worktree.setupTimeoutSeconds as number,
    },
    ...(nonEmptyString(value.workspaceRoot) === undefined ? {} : { workspaceRoot: value.workspaceRoot as string }),
    ...(permanentPrompt === undefined || permanentPrompt.length === 0 ? {} : { permanentPrompt }),
    ...(guideline === undefined || guideline.length === 0 ? {} : { additionalGuideline: guideline }),
  };
}

function parseFrozenIssue(value: unknown): FrozenIssue | undefined {
  if (!isRecord(value)) return undefined;
  const number = positiveInteger(value.number);
  const title = nonEmptyString(value.title);
  const branch = nonEmptyString(value.branch);
  const issueDisposition = disposition(value.disposition);
  const dependsOn = numbers(value.dependsOn ?? []);
  if (number === undefined || title === undefined || branch === undefined || issueDisposition === undefined || (value.chrome !== undefined && value.chrome !== true) || dependsOn === undefined) {
    return undefined;
  }
  const tier = difficulty(value.difficulty);
  if (value.difficulty !== undefined && tier === undefined) return undefined;
  return {
    number,
    title,
    branch,
    disposition: issueDisposition,
    ...(tier === undefined ? {} : { difficulty: tier }),
    ...(value.chrome === true ? { chrome: true as const } : {}),
    dependsOn,
  };
}

function parseProgress(value: unknown): IssueProgress | undefined {
  if (!isRecord(value)) return undefined;
  if (value.state === "pending") return { state: "pending" };
  if (value.state === "current") {
    const phase = AUTO_RUN_PHASES.includes(value.phase as AutoRunPhase) ? value.phase as AutoRunPhase : undefined;
    if (phase === undefined) return undefined;
    const prNumber = positiveInteger(value.prNumber);
    const headSha = fullSha(value.headSha);
    if (value.prNumber !== undefined && prNumber === undefined) return undefined;
    if (value.headSha !== undefined && headSha === undefined) return undefined;
    if (value.reviewed !== undefined && value.reviewed !== true) return undefined;
    if (value.expectedBranch !== undefined && nonEmptyString(value.expectedBranch) === undefined) return undefined;
    if (value.mergeSha !== undefined && fullSha(value.mergeSha) === undefined) return undefined;
    if (value.issueClosed !== undefined && value.issueClosed !== true) return undefined;
    for (const sha of [value.beforeSha, value.implementationSha, value.reviewedSha]) if (sha !== undefined && fullSha(sha) === undefined) return undefined;
    return {
      state: "current",
      phase,
      ...(prNumber === undefined ? {} : { prNumber }),
      ...(headSha === undefined ? {} : { headSha }),
      ...(value.reviewed === true ? { reviewed: true as const } : {}),
      ...(value.beforeSha === undefined ? {} : { beforeSha: value.beforeSha as string }),
      ...(value.implementationSha === undefined ? {} : { implementationSha: value.implementationSha as string }),
      ...(value.reviewedSha === undefined ? {} : { reviewedSha: value.reviewedSha as string }),
      ...(value.expectedBranch === undefined ? {} : { expectedBranch: value.expectedBranch as string }),
      ...(value.mergeSha === undefined ? {} : { mergeSha: value.mergeSha as string }),
      ...(value.issueClosed === true ? { issueClosed: true as const } : {}),
    };
  }
  if (value.state !== "done") return undefined;
  if (value.result === "no-changes") return { state: "done", result: "no-changes" };
  if (value.result !== "landed") return undefined;
  const prNumber = positiveInteger(value.prNumber);
  if (prNumber === undefined || typeof value.issueClosed !== "boolean") return undefined;
  for (const sha of [value.beforeSha, value.implementationSha, value.reviewedSha]) if (sha !== undefined && fullSha(sha) === undefined) return undefined;
  return { state: "done", result: "landed", prNumber, issueClosed: value.issueClosed,
    ...(value.beforeSha === undefined ? {} : { beforeSha: value.beforeSha as string }),
    ...(value.implementationSha === undefined ? {} : { implementationSha: value.implementationSha as string }),
    ...(value.reviewedSha === undefined ? {} : { reviewedSha: value.reviewedSha as string }) };
}

function parsePendingAction(value: unknown): PendingAction | undefined {
  if (!isRecord(value)) return undefined;
  const branch = nonEmptyString(value.branch);
  const head = nonEmptyString(value.head);
  const base = nonEmptyString(value.base);
  const prNumber = positiveInteger(value.prNumber);
  switch (value.kind) {
    case "comment-issue": {
      const issue = positiveInteger(value.issue);
      if (issue === undefined || typeof value.body !== "string") return undefined;
      return { kind: "comment-issue", issue, body: value.body };
    }
    case "close-issue": {
      const issue = positiveInteger(value.issue);
      if (issue === undefined || prNumber === undefined || typeof value.comment !== "string") return undefined;
      return { kind: "close-issue", issue, prNumber, comment: value.comment };
    }
    case "cleanup-issue": {
      const issue = positiveInteger(value.issue);
      const sha = fullSha(value.sha);
      if (issue === undefined || branch === undefined || sha === undefined) return undefined;
      return { kind: "cleanup-issue", issue, branch, sha };
    }
    case "create-branch": {
      const baseSha = fullSha(value.baseSha);
      if (branch === undefined || base === undefined || baseSha === undefined) return undefined;
      return { kind: "create-branch", branch, base, baseSha };
    }
    case "worker-commit": {
      const parentSha = fullSha(value.parentSha);
      if (branch === undefined || parentSha === undefined || (value.role !== "implementer" && value.role !== "reviewer")) return undefined;
      if (value.outcome !== undefined && value.outcome !== "succeeded" && value.outcome !== "failed") return undefined;
      return { kind: "worker-commit", branch, parentSha, role: value.role,
        ...(value.outcome === undefined ? {} : { outcome: value.outcome }) };
    }
    case "push": {
      const sha = fullSha(value.sha);
      if (branch === undefined || sha === undefined) return undefined;
      return { kind: "push", branch, sha };
    }
    case "create-issue-pr": {
      const issue = positiveInteger(value.issue);
      if (issue === undefined || head === undefined || base === undefined) return undefined;
      return { kind: "create-issue-pr", issue, head, base };
    }
    case "merge-issue-pr":
      if (prNumber === undefined || head === undefined || base === undefined || fullSha(value.headSha) === undefined || fullSha(value.baseSha) === undefined) return undefined;
      return { kind: "merge-issue-pr", prNumber, head, base, headSha: value.headSha as string, baseSha: value.baseSha as string };
    case "create-run-pr":
      if (head === undefined || base === undefined) return undefined;
      return { kind: "create-run-pr", head, base };
    case "update-run-pr": {
      const title = nonEmptyString(value.title);
      if (prNumber === undefined || title === undefined || typeof value.body !== "string") return undefined;
      return { kind: "update-run-pr", prNumber, title, body: value.body };
    }
    case "merge-run-pr":
      if (prNumber === undefined || head === undefined || base === undefined || fullSha(value.headSha) === undefined || fullSha(value.baseSha) === undefined) return undefined;
      return { kind: "merge-run-pr", prNumber, head, base, headSha: value.headSha as string, baseSha: value.baseSha as string };
    default:
      return undefined;
  }
}

function parseOutcome(value: unknown): RunAttemptOutcome | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "cancelled") return { kind: "cancelled" };
  if (value.kind === "interrupted") return { kind: "interrupted" };
  if (value.kind !== "failed") return undefined;
  const reason = nonEmptyString(value.reason);
  return reason === undefined ? undefined : { kind: "failed", reason };
}

export function parseAutoRunRecord(value: unknown): PersistedAutoRunRecord | undefined {
  if (!isRecord(value)) return undefined;
  const runId = nonEmptyString(value.runId);
  const startedAt = timestamp(value.startedAt);
  if (runId === undefined || startedAt === undefined) return undefined;
  if ((value.version === 1 || value.version === 2)) return { version: value.version, runId, startedAt };
  if (value.version !== 3) return undefined;

  const settings = parseFrozenSettings(value.settings);
  const sessionBranch = nonEmptyString(value.sessionBranch);
  const targetBranch = nonEmptyString(value.targetBranch);
  const checkpoint = RUN_CHECKPOINTS.includes(value.checkpoint as RunCheckpoint) ? value.checkpoint as RunCheckpoint : undefined;
  const attempt = positiveInteger(value.attempt);
  const plan = Array.isArray(value.plan) ? value.plan.map(parseFrozenIssue) : undefined;
  const updatedAt = timestamp(value.updatedAt);
  if (
    settings === undefined || sessionBranch === undefined || targetBranch === undefined || checkpoint === undefined
    || attempt === undefined || updatedAt === undefined || plan === undefined || plan.some((issue) => issue === undefined)
  ) return undefined;

  if (!isRecord(value.progress)) return undefined;
  const progress: Record<string, IssueProgress> = {};
  const issueNumbers = new Set((plan as FrozenIssue[]).map((issue) => String(issue.number)));
  if (issueNumbers.size !== plan.length) return undefined;
  for (const key of issueNumbers) {
    const parsed = parseProgress(value.progress[key]);
    if (parsed === undefined) return undefined;
    progress[key] = parsed;
  }
  if (Object.keys(value.progress).some((key) => !issueNumbers.has(key))) return undefined;

  if (!isRecord(value.branchShas)) return undefined;
  const branchShas: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.branchShas)) {
    const sha = fullSha(entry);
    if (sha === undefined) return undefined;
    branchShas[key] = sha;
  }
  const pendingAction = parsePendingAction(value.pendingAction);
  const outcome = parseOutcome(value.outcome);
  const runPullRequest = positiveInteger(value.runPullRequest);
  const currentIssue = positiveInteger(value.currentIssue);
  const reviewedIssues = numbers(value.reviewedIssues);
  const targetHeadSha = fullSha(value.targetHeadSha);
  const unpublishedTargetCommits = positiveInteger(value.unpublishedTargetCommits);
  const workerSession = isRecord(value.workerSession) ? value.workerSession : undefined;
  if (value.pendingAction !== undefined && pendingAction === undefined) return undefined;
  if (value.outcome !== undefined && outcome === undefined) return undefined;
  if (value.runPullRequest !== undefined && runPullRequest === undefined) return undefined;
  if (value.currentIssue !== undefined && currentIssue === undefined) return undefined;
  if (value.targetHeadSha !== undefined && targetHeadSha === undefined) return undefined;
  if (value.unpublishedTargetCommits !== undefined && unpublishedTargetCommits === undefined) return undefined;
  if (reviewedIssues === undefined) return undefined;
  if (value.workspaceCreated !== undefined && value.workspaceCreated !== true) return undefined;
  if (value.workerSession !== undefined && (
    workerSession === undefined
    || nonEmptyString(workerSession.agentId) === undefined
    || nonEmptyString(workerSession.sessionId) === undefined
    || (workerSession.type !== "implementer" && workerSession.type !== "reviewer" && workerSession.type !== "Explore")
    || positiveInteger(workerSession.issueNumber) === undefined
    || (workerSession.continuable !== undefined && (workerSession.continuable !== true || workerSession.type === "Explore"))
  )) return undefined;
  if (currentIssue !== undefined && (!issueNumbers.has(String(currentIssue)) || progress[String(currentIssue)]?.state !== "current")) return undefined;
  return {
    version: 3,
    runId,
    startedAt,
    updatedAt,
    attempt,
    settings,
    plan: plan as FrozenIssue[],
    progress,
    sessionBranch,
    targetBranch,
    ...(targetHeadSha === undefined ? {} : { targetHeadSha }),
    ...(unpublishedTargetCommits === undefined ? {} : { unpublishedTargetCommits }),
    branchShas,
    currentIssue,
    checkpoint,
    ...(runPullRequest === undefined ? {} : { runPullRequest }),
    reviewedIssues,
    ...(pendingAction === undefined ? {} : { pendingAction }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(value.workspaceCreated === true ? { workspaceCreated: true as const } : {}),
    ...(workerSession === undefined ? {} : { workerSession: {
      agentId: workerSession.agentId as AgentId,
      sessionId: workerSession.sessionId as SessionId,
      type: workerSession.type as "implementer" | "reviewer" | "Explore",
      issueNumber: workerSession.issueNumber as number,
      ...(workerSession.continuable === true ? { continuable: true as const } : {}),
    } }),
  };
}

export class FileAutoRunStore extends AtomicJsonFile<PersistedAutoRunRecord> {
  public constructor(runtime: RuntimeLayout, admission?: RuntimeAdmission) {
    super(runtime.state("auto-run.json"), parseAutoRunRecord, admission);
  }

  public async clear(): Promise<void> {
    await this.remove();
  }
}

export class PersistOnChange {
  readonly #registration: { dispose(): void };
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;
  public constructor(register: (listener: () => void) => { dispose(): void }, private readonly save: () => Promise<void>, private readonly onError: (error: unknown) => void) {
    this.#registration = register(() => { this.#pending = this.#pending.then(() => this.#disposed ? undefined : this.save()).catch(this.onError); });
  }
  public async dispose(): Promise<void> { this.#registration.dispose(); await this.#pending; await this.save(); this.#disposed = true; }
}

/** Narrowing helper so callers can accept only the fixed-plan shape. */
export function isFixedPlanRecord(record: PersistedAutoRunRecord | undefined): record is AutoRunRecord {
  return record?.version === 3;
}
