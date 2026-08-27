/**
 * The write side of the activity store.
 *
 * Appends are chained rather than concurrent: a session can settle from two
 * sources within milliseconds — the terminal closing and the wrapper's marker
 * vanishing — and two read-modify-writes racing on one file would drop an
 * entry. Appends are idempotent per entry id, so the second observation simply
 * refreshes the first.
 *
 * Every write is best-effort by contract. This runs on settlement paths where
 * throwing would strand the lease or the fleet record; a failed write costs one
 * history row and is logged.
 */

import {
  EMPTY_ACTIVITY,
  agentActivity,
  appendActivity,
  migrateLegacySessions,
  runActivity,
  type ActivityDto,
  type ActivityEntry,
  type AgentOutcome,
  type RunOutcome,
} from "../domain/activity.js";
import type { AgentSession, IsoTimestamp, TerminalId } from "../domain/contracts.js";
import type { FileActivityStore, FileLegacySessionLedger } from "./persistence.js";

export interface ActivityRecorderOptions {
  readonly store: FileActivityStore;
  /** Read once so its reopenable sessions survive; never written again. */
  readonly legacy?: FileLegacySessionLedger;
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

  /**
   * Loads the store and folds the superseded session ledger into it, once. The
   * migration is idempotent because it skips any agent already represented, so
   * a reload that happens before the old file is removed changes nothing.
   */
  public async load(): Promise<void> {
    const current = await this.options.store.load().catch(() => undefined) ?? EMPTY_ACTIVITY;
    const legacy = await this.options.legacy?.load().catch(() => undefined);
    const merged = legacy === undefined ? current : migrateLegacySessions(current, legacy.sessions);
    this.#cache = merged;
    this.options.onDidChange();
    if (legacy !== undefined && merged !== current) this.#enqueue(() => merged);
    if (legacy !== undefined) await this.options.legacy?.remove().catch(() => undefined);
  }

  public recordAgent(
    session: AgentSession,
    outcome: AgentOutcome,
    at: IsoTimestamp = this.#now(),
    options: { readonly reason?: string; readonly terminalId?: TerminalId } = {},
  ): void {
    this.#append(agentActivity(session, outcome, at, options));
  }

  public recordRun(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly outcome: RunOutcome;
    readonly reason?: string;
    readonly issueNumbers?: readonly number[];
    readonly pullRequest?: number;
  }): void {
    this.#append(runActivity({ ...input, at: this.#now() }));
  }

  public async clear(): Promise<void> {
    this.#cache = EMPTY_ACTIVITY;
    this.options.onDidChange();
    await this.options.store.clear().catch((error: unknown) => {
      this.options.log(`Activity store could not be cleared: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }

  #append(entry: ActivityEntry): void {
    // Writing into an uninitialized project would recreate `.aboard/` behind the
    // user's back — including right after they deleted it.
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
