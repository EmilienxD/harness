import type { AgentId } from "../domain/contracts.js";
import { isWorkingTreeClean, type GitClient } from "../git/client.js";
import type { DelegationLaunchInput, InteractiveLaunchHandles } from "./delegation.js";

export const GENERAL_PURPOSE_QUEUE_POLL_MS = 2_000;

export interface GeneralPurposeQueueLauncher {
  launchQueued(input: DelegationLaunchInput, beforeTerminal: () => Promise<void>): Promise<Pick<InteractiveLaunchHandles, "agentId">>;
}

export type GeneralPurposeQueueOutcome =
  | { readonly status: "launched"; readonly agentId: string }
  | { readonly status: "cancelled" }
  | { readonly status: "queued"; readonly position: number; readonly reason: string };

interface QueueEntry {
  readonly id: number;
  readonly prompt: string;
}

interface ActiveEntry {
  readonly agentId: AgentId;
  /** The next task needs a new descendant of the commit at launch. */
  readonly head: string;
}

export interface GeneralPurposeQueueOptions {
  readonly git: Pick<GitClient, "status" | "headSha" | "isAncestor">;
  readonly launcher: GeneralPurposeQueueLauncher;
  readonly canLaunch?: () => boolean;
  readonly isAgentLive: (agentId: AgentId) => boolean;
  readonly onLaunch?: (agentId: AgentId, remaining: number) => void;
  readonly onError?: (message: string) => void;
  readonly pollMs?: number;
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/**
 * A deliberately small, in-memory FIFO for Manager-authored one-shot work.
 *
 * The active task is retained after its session ends until both postconditions
 * are visible: the working tree is clean and HEAD has advanced from the commit at
 * launch. A merely-still-clean tree can therefore never drain the next item
 * before the first agent has had a chance to edit anything.
 */
export class GeneralPurposeQueue {
  readonly #pending: QueueEntry[] = [];
  readonly #setInterval: (callback: () => void, intervalMs: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  #active: ActiveEntry | undefined;
  #nextId = 1;
  #operation: Promise<unknown> = Promise.resolve();
  #timer: unknown;
  #disposed = false;
  #generation = 0;
  #pollQueued = false;
  #lastError: string | undefined;
  #waitReason = "the working tree is not clean";

  public constructor(private readonly options: GeneralPurposeQueueOptions) {
    this.#setInterval = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.#clearInterval = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  public async enqueue(prompt: string): Promise<GeneralPurposeQueueOutcome> {
    const generation = this.#generation;
    return this.#serialize(async () => {
      if (!this.#current(generation)) return { status: "cancelled" };
      if (prompt.trim().length === 0) throw new Error("A queued task requires a message");
      const entry: QueueEntry = { id: this.#nextId++, prompt };
      this.#pending.push(entry);
      this.#startPolling();
      const launched = await this.#drain(generation, entry.id);
      if (!this.#current(generation)) return { status: "cancelled" };
      if (launched !== undefined) return { status: "launched", agentId: launched };
      return {
        status: "queued",
        position: this.#pending.findIndex((candidate) => candidate.id === entry.id) + 1,
        reason: this.#waitReason,
      };
    });
  }

  public dispose(): void {
    this.#disposed = true;
    this.clear();
  }

  /** Drops ephemeral work when project admission closes; reinitialization starts fresh. */
  public clear(): void {
    this.#generation += 1;
    if (this.#timer !== undefined) this.#clearInterval(this.#timer);
    this.#timer = undefined;
    this.#pending.length = 0;
    this.#active = undefined;
    this.#lastError = undefined;
    this.#waitReason = "the working tree is not clean";
  }

  #current(generation: number): boolean {
    return !this.#disposed && this.#generation === generation;
  }

  async #readyHead(generation: number): Promise<string | undefined> {
    if (!this.#current(generation)) return undefined;
    if (this.options.canLaunch?.() === false) {
      this.#waitReason = "another aboard workflow is active or the project is not initialized";
      return undefined;
    }
    this.#waitReason = "the preceding task must finish with a new commit and a clean working tree";
    if (this.#active !== undefined && this.options.isAgentLive(this.#active.agentId)) return undefined;
    const head = await this.options.git.headSha(false);
    const status = await this.options.git.status();
    if (!this.#current(generation)) return undefined;
    if (!isWorkingTreeClean(status)) {
      if (this.#active === undefined) this.#waitReason = "the working tree is not clean";
      return undefined;
    }
    if (this.#active !== undefined && (head === this.#active.head || !await this.options.git.isAncestor(this.#active.head, head))) return undefined;
    // Ref changes during the status read must not produce a mixed snapshot.
    if (head !== await this.options.git.headSha(false)) return undefined;
    return this.#current(generation) && this.options.canLaunch?.() !== false ? head : undefined;
  }

  async #drain(generation: number, wantedId?: number): Promise<string | undefined> {
    if (!this.#current(generation) || this.#pending.length === 0) {
      this.#stopPollingIfIdle();
      return undefined;
    }
    try {
      if (await this.#readyHead(generation) === undefined) return undefined;
      const next = this.#pending[0]!;
      let launchHead: string | undefined;
      const launched = await this.options.launcher.launchQueued({
        type: "general-purpose",
        prompt: next.prompt,
        // Prompts stay in memory/private launch files, not persistent activity metadata.
        description: `queued general purpose task ${next.id}`,
      }, async () => {
        launchHead = await this.#readyHead(generation);
        if (launchHead === undefined) throw new Error("Queue admission changed during launch preparation");
      });
      if (!this.#current(generation)) return undefined;
      if (launchHead === undefined) throw new Error("Queued launch did not verify its working tree");
      this.#pending.shift();
      this.#active = { agentId: launched.agentId, head: launchHead };
      this.#lastError = undefined;
      this.#waitReason = "the preceding task must finish with a new commit and a clean working tree";
      this.options.onLaunch?.(this.#active.agentId, this.#pending.length);
      this.#stopPollingIfIdle();
      return next.id === wantedId ? launched.agentId : undefined;
    } catch (error) {
      if (!this.#current(generation)) return undefined;
      const message = error instanceof Error ? error.message : "the queue check failed";
      this.#waitReason = `launch is temporarily unavailable: ${message}`;
      if (message !== this.#lastError) this.options.onError?.(message);
      this.#lastError = message;
      return undefined;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#operation.then(operation, operation);
    this.#operation = next.then(() => undefined, () => undefined);
    return next;
  }

  #startPolling(): void {
    if (this.#timer !== undefined || this.#disposed) return;
    const generation = this.#generation;
    this.#timer = this.#setInterval(() => {
      if (this.#pollQueued || !this.#current(generation)) return;
      this.#pollQueued = true;
      void this.#serialize(() => this.#drain(generation)).finally(() => { this.#pollQueued = false; });
    }, this.options.pollMs ?? GENERAL_PURPOSE_QUEUE_POLL_MS);
  }

  #stopPollingIfIdle(): void {
    if (this.#pending.length > 0 || this.#timer === undefined) return;
    this.#clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
