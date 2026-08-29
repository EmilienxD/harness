import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId } from "../domain/contracts.js";

export const AGENT_COUNTER_FILE_NAME = "agent-counter.json";

export class WorkspaceAgentIdCounter {
  readonly #path: string;
  #next: number;

  private constructor(path: string, next: number, private readonly admission: () => boolean) {
    this.#path = path;
    this.#next = next;
  }

  public static load(projectRoot: string, seeder?: () => Iterable<string>, admission: () => boolean = () => true): WorkspaceAgentIdCounter {
    const path = join(projectRoot, ".aboard", "runtime", AGENT_COUNTER_FILE_NAME);
    const persisted = this.#readCeiling(path);
    const fleet = seeder === undefined ? 0 : this.#fleetCeiling(seeder());
    return new WorkspaceAgentIdCounter(path, Math.max(persisted, fleet) + 1, admission);
  }

  public next(): AgentId {
    if (!this.admission()) throw new Error("aboard runtime is not initialized");
    const value = this.#next;
    this.#next = value + 1;
    this.#persistCeiling(value);
    return String(value) as AgentId;
  }

  static #readCeiling(path: string): number {
    if (!existsSync(path)) return 0;
    try {
      const record: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof record !== "object" || record === null || Array.isArray(record)) return 0;
      const value = (record as Record<string, unknown>).value;
      return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
    } catch {
      // Corrupt or unreadable: bootstrap rather than fail activation. Returning
      // 0 defers to the fleet ceiling, which protects the exact range at risk.
      return 0;
    }
  }

  static #fleetCeiling(ids: Iterable<string>): number {
    let ceiling = 0;
    for (const id of ids) {
      if (/^\d+$/.test(id)) {
        const value = Number(id);
        if (Number.isSafeInteger(value) && value > ceiling) ceiling = value;
      }
    }
    return ceiling;
  }

  #persistCeiling(value: number): void {
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify({ version: 1, value })}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        closeSync(openSync(this.#path, "wx"));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // mkdir above guarantees the parent exists, so rename cannot race a
      // missing directory on the steady-state path.
      renameSync(temporary, this.#path);
    } catch {
      // Persistence is best-effort: a failed write skips ids at worst, never
      // repeats them. Drop only the temp file; never the real counter.
      rmSync(temporary, { force: true });
    }
  }
}
