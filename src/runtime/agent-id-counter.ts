import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId } from "../domain/contracts.js";

export const AGENT_COUNTER_FILE_NAME = "agent-counter.json";

/**
 * Mints user-facing agent ids as sequential integers. The ids exist so a
 * Claude Code session label reads `aboard-implementer-4` rather than carrying
 * a UUID. The sequence belongs to one initialized runtime and is reset when
 * `.aboard/` is deleted. The counter file lives under `.aboard/runtime/`.
 */
export class WorkspaceAgentIdCounter {
  readonly #path: string;
  #next: number;

  private constructor(path: string, next: number, private readonly admission: () => boolean) {
    this.#path = path;
    this.#next = next;
  }

  /**
   * Loads the persisted counter and seeds it from the fleet's id ceiling for
   * the number range. Seeding matters on upgrade: ids minted by this version
   * are numbers, and an earlier run of it may have created launches `1..N`
   * whose runtime residue (locks, exit records, spilled prompts) a low restart
   * of the sequence would then collide with. A counter bootstrapped from the
   * fleet's highest number restarts past every launch this scheme already
   * made. Pre-numeric (UUID) ids contribute nothing to the ceiling: their
   * launch files live at UUID-named paths, which plain numbers can never
   * match, so reusing 1..N alongside them is collision-free.
   */
  public static load(projectRoot: string, seeder?: () => Iterable<string>, admission: () => boolean = () => true): WorkspaceAgentIdCounter {
    const path = join(projectRoot, ".aboard", "runtime", AGENT_COUNTER_FILE_NAME);
    const persisted = this.#readCeiling(path);
    const fleet = seeder === undefined ? 0 : this.#fleetCeiling(seeder());
    return new WorkspaceAgentIdCounter(path, Math.max(persisted, fleet) + 1, admission);
  }

  /**
   * Returns the next id and advances the persisted sequence. The returned id
   * is the number as a string (the file keeps the dedicated number for parse
   * robustness). Minting never recycles a number, so nothing that keys on an
   * agent id — lock markers, exit records, spilled prompts, fleet records —
   * can collide. Uniqueness does not depend on the write succeeding: both
   * potential writers run inside this in-process mint, and two extension-host
   * processes (two windows on one workspace) are serialized by the
   * OS-atomic rename, so a crash or a lost race between the in-memory advance
   * and the durable store can only skip ids, never repeat them.
   */
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
        // Atomic over a crashed or racing writer: a torn or stale counter would
        // restart the sequence and reuse ids, so the bootstrap write is
        // create-exclusive (EEXIST is not an error — nothing to clobber).
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
