import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUTO_RUN_PHASES, AUTO_RUN_SCOPES, type AutoRunPhase, type AutoRunRecord, type AutoRunScope } from "../domain/auto-run.js";
import type { FleetPersistenceDto } from "../domain/fleet.js";
import { parseFleetPersistenceDto } from "../domain/validation.js";

export class AtomicJsonFile<T> {
  public constructor(private readonly path: string, private readonly parse: (value: unknown) => T | undefined) {}
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
  public constructor(workspaceRoot: string) {
    super(join(workspaceRoot, ".aboard", "runtime", "fleet.json"), (value) => {
      const result = parseFleetPersistenceDto(value);
      return result.ok ? result.value : undefined;
    });
  }
}

/**
 * Parses `.aboard/runtime/auto-run.json`. It is a resume *hint*, so a record
 * that fails to parse degrades to "no run to resume" rather than an error: the
 * engine re-derives every fact from git and GitHub anyway.
 */
export function parseAutoRunRecord(value: unknown): AutoRunRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  const positiveInteger = (candidate: unknown): number | undefined =>
    Number.isInteger(candidate) && (candidate as number) > 0 ? (candidate as number) : undefined;
  const runId = typeof record.runId === "string" && record.runId.trim().length > 0 ? record.runId : undefined;
  const specNumber = positiveInteger(record.specNumber);
  const startedAt = typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt)) ? record.startedAt : undefined;
  const phase = AUTO_RUN_PHASES.includes(record.phase as AutoRunPhase) ? (record.phase as AutoRunPhase) : undefined;
  const scope = AUTO_RUN_SCOPES.includes(record.scope as AutoRunScope) ? (record.scope as AutoRunScope) : undefined;
  const issueNumbers = Array.isArray(record.issueNumbers)
    ? record.issueNumbers.map(positiveInteger)
    : undefined;
  if (
    runId === undefined || specNumber === undefined || startedAt === undefined || phase === undefined
    || scope === undefined || issueNumbers === undefined || issueNumbers.some((number) => number === undefined)
    || typeof record.reviewMode !== "boolean"
  ) return undefined;
  return {
    version: 1,
    runId,
    specNumber,
    issueNumbers: issueNumbers as number[],
    currentIssue: positiveInteger(record.currentIssue),
    phase,
    branch: typeof record.branch === "string" && record.branch.length > 0 ? record.branch : undefined,
    prNumber: positiveInteger(record.prNumber),
    reviewMode: record.reviewMode,
    scope,
    // Optional: records written before this field existed degrade to "no safe
    // branch to return to", and a run that started on a detached HEAD stored
    // none either. The end-of-run restore is skipped in both cases.
    returnBranch: typeof record.returnBranch === "string" && record.returnBranch.length > 0 ? record.returnBranch : undefined,
    // Degrades to "nothing reviewed yet" rather than rejecting the record: a
    // repeated review costs tokens, a skipped one loses the review.
    reviewedIssues: Array.isArray(record.reviewedIssues)
      ? record.reviewedIssues.filter((candidate): candidate is number => positiveInteger(candidate) !== undefined)
      : [],
    startedAt,
  };
}

export class FileAutoRunStore extends AtomicJsonFile<AutoRunRecord> {
  public constructor(workspaceRoot: string) {
    super(join(workspaceRoot, ".aboard", "runtime", "auto-run.json"), parseAutoRunRecord);
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
