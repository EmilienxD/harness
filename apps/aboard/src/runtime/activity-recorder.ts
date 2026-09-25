
import {
  EMPTY_ACTIVITY,
  agentActivity,
  appendActivity,

  runActivity,
  type ActivityDto,
  type ActivityEntry,
  type AgentOutcome,
  type RunOutcome,
} from "../domain/activity.js";
import type { AgentSession, IsoTimestamp, SessionId, TerminalId } from "../domain/contracts.js";
import type { FileActivityStore } from "./persistence.js";

export interface ActivityRecorderOptions {
  readonly store: FileActivityStore;

  /** Writes are refused while the project is not initialized. */
  readonly admission: () => boolean;
  readonly now: () => Date;
  readonly log: (message: string) => void;
  readonly onDidChange: () => void;
}

export class ActivityRecorder {
  #cache: ActivityDto = EMPTY_ACTIVITY;
  #writes: Promise<void> = Promise.resolve();

  public constructor(private readonly options: ActivityRecorderOptions) {}

  public entries(): readonly ActivityEntry[] {
    return this.#cache.entries;
  }

  public store(): ActivityDto {
    return this.#cache;
  }

  public async load(): Promise<void> {
    this.#cache = await this.options.store.load().catch(() => undefined) ?? EMPTY_ACTIVITY;
    this.options.onDidChange();
  }

  public recordAgent(
    session: AgentSession,
    outcome: AgentOutcome,
    at: IsoTimestamp = this.#now(),
    options: { readonly reason?: string; readonly terminalId?: TerminalId } = {},
  ): void {
    this.#append(agentActivity(session, outcome, at, options));
  }

  public setTitle(sessionId: SessionId, title: string): void {
    const clean = title.trim();
    if (!clean || !this.options.admission()) return;
    let changed = false;
    const entries = this.#cache.entries.map((entry) => {
      if (entry.kind !== "agent" || entry.reopen?.sessionId !== sessionId || entry.title === clean) return entry;
      changed = true;
      return { ...entry, title: clean };
    });
    if (!changed) return;
    this.#cache = { ...this.#cache, entries };
    this.options.onDidChange();
    this.#enqueue(() => this.#cache);
  }

  public recordRun(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly outcome: RunOutcome;
    readonly reason?: string;
    readonly issueNumbers?: readonly number[];
    readonly pullRequest?: number;
    readonly completedIssues?: number;
    readonly totalIssues?: number;
    readonly currentIssue?: number;
  }): void {
    const at = this.#now();
    const beginning = this.#cache.entries.find((entry) =>
      entry.kind === "run" && entry.runId === input.runId && entry.attempt === input.attempt
      && (entry.outcome === "started" || entry.outcome === "resumed"));
    const durationMs = beginning === undefined ? undefined : Math.max(0, Date.parse(at) - Date.parse(beginning.at));
    this.#append(runActivity({
      ...input,
      at,
      ...(durationMs === undefined || !Number.isFinite(durationMs) ? {} : { durationMs }),
    }));
  }

  public async clear(): Promise<void> {
    this.#cache = EMPTY_ACTIVITY;
    this.options.onDidChange();
    await this.options.store.clear().catch((error: unknown) => {
      this.options.log(`Activity store could not be cleared: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }

  public async reset(): Promise<void> {
    await this.settle();
    this.#cache = EMPTY_ACTIVITY;
    this.options.onDidChange();
  }

  #append(entry: ActivityEntry): void {
    // Writing into an uninitialized project would recreate `.abd/` behind the
    // user's back; including right after they deleted it.
    if (!this.options.admission()) return;
    this.#cache = appendActivity(this.#cache, entry);
    this.options.onDidChange();
    this.#enqueue(() => this.#cache);
  }

  #enqueue(value: () => ActivityDto): void {
    this.#writes = this.#writes
      .then(() => this.options.store.save(value()))
      .catch((error: unknown) => {
        this.options.log(`Activity store write failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
  }

  #now(): IsoTimestamp {
    return this.options.now().toISOString() as IsoTimestamp;
  }

  /** Flushes queued writes, so a normal shutdown does not lose the last outcome. */
  public async settle(): Promise<void> {
    await this.#writes;
  }
}
