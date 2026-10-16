import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WorkspaceBatchResult, WorkspaceLaunchPlan } from "../platform/workspace-launcher.js";
import { ownerRuntimeDirectory, WorkspaceRequestJournal, WorkspaceRequestUncertainError, type WorkspaceHandoff } from "./agent-workspace-owner.js";

interface Owner { pid: number; activationId: string }

async function readOwner(path: string): Promise<Owner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<Owner> | null;
    return value && Number.isInteger(value.pid) && Number(value.pid) > 0 && typeof value.activationId === "string" ? value as Owner : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Shared startup state is available before the destination's bridge initializes. */
export class WorkspaceStartup {
  readonly #directory: string;
  readonly #journal: WorkspaceRequestJournal;

  constructor(storageRoot: string, private readonly handoff: WorkspaceHandoff) {
    this.#directory = ownerRuntimeDirectory(storageRoot, handoff.ownerId);
    this.#journal = new WorkspaceRequestJournal(join(this.#directory, "startup-requests"));
  }

  /** Called immediately after this activation acquires the owner lease. */
  async opened(): Promise<void> {
    const owner = await readOwner(join(this.#directory, "owner.lock"));
    if (!owner) throw new Error("The workspace startup has no owner lease");
    const path = join(this.#directory, "startup-owner.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  execute(operation: () => Promise<WorkspaceBatchResult>): Promise<WorkspaceBatchResult> {
    return this.#journal.execute(this.handoff.requestId, operation, this.handoff.plan);
  }

  async #state(): Promise<"opening" | "open" | "closed"> {
    const started = await readOwner(join(this.#directory, "startup-owner.json"));
    if (!started) return "opening";
    const owner = await readOwner(join(this.#directory, "owner.lock"));
    return owner?.activationId === started.activationId && owner.pid === started.pid && alive(owner.pid) ? "open" : "closed";
  }

  async #cancel(closed: boolean): Promise<WorkspaceBatchResult | undefined> {
    const plan = this.handoff.plan as WorkspaceLaunchPlan;
    const result = { started: 0, failed: [], cancelled: plan.empty ? 0 : plan.preset.panes.reduce((count, pane) => count + Math.max(1, pane.providers.length), 0) };
    try { return await this.execute(async () => result); }
    catch (error) {
      // A dead owner may already have started effects. Keep that request reserved.
      if (error instanceof WorkspaceRequestUncertainError) return closed ? result : undefined;
      throw error;
    }
  }

  async wait(options: { sleep?: (ms: number) => Promise<void>; now?: () => number; timeoutMs?: number; activationTimeoutMs?: number } = {}): Promise<WorkspaceBatchResult> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + (options.timeoutMs ?? 120_000);
    const activationDeadline = now() + (options.activationTimeoutMs ?? 15_000);
    while (now() < deadline) {
      const request = await this.#journal.read(this.handoff.requestId);
      if (request?.state === "completed") return request.result as WorkspaceBatchResult;
      const state = await this.#state();
      if (state === "closed" || (state === "opening" && now() >= activationDeadline)) {
        const cancelled = await this.#cancel(state === "closed");
        if (cancelled) return cancelled;
      }
      await sleep(250);
    }
    throw new Error("The workspace has not finished starting. Its original request remains reserved.");
  }
}
