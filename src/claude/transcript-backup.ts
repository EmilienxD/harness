
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { SessionId } from "../domain/contracts.js";
import { claudeConfigDirectory, sessionTranscriptPath, transcriptHoldsConversation } from "./sessions.js";

/** Manager transcripts retained by default; older ones are pruned as sessions turn over. */
export const DEFAULT_TRANSCRIPT_BACKUPS = 5;

export const OVERLAP_VERIFY_BYTES = 4_096;

export type TranscriptCheckpointOutcome =
  /** Retention is 0: the user turned backups off. */
  | "disabled"
  /** Claude Code has no transcript for this session — nothing to copy yet, or the sweep already ran. */
  | "no-source"
  /** The backup already holds every byte the live transcript does. */
  | "unchanged"
  /** The backup is longer than the live transcript and still contains it: the sweep-and-recreate case, where the copy is the better record. */
  | "ahead"
  | "appended"
  | "copied"
  | "failed";

export type TranscriptRestoreOutcome =
  | "disabled"
  /** Claude Code still holds a resumable transcript; the backup is not needed. */
  | "live"
  | "restored"
  /** No backup exists, or the one that does holds no conversation. */
  | "no-backup"
  | "failed";

export interface TranscriptBackupOptions {
  readonly workspaceRoot: string;
  /** Retention count, read per call so a settings change applies without a reload. `0` disables both directions. */
  readonly retain?: () => number;
  /** Overridden by tests; resolved per call because `CLAUDE_CONFIG_DIR` is environment, not launch state. */
  readonly configDirectory?: () => string;
  /** Absolute directory in VS Code's workspace storage. */
  readonly directory: string;
  readonly log?: (message: string) => void;
}

export class TranscriptBackupStore {
  readonly #options: TranscriptBackupOptions;
  readonly #directory: string;
  #queue: Promise<unknown> = Promise.resolve();

  public constructor(options: TranscriptBackupOptions) {
    this.#options = options;
    this.#directory = options.directory;
  }

  /** Where this session's copy lives. Exposed so a caller can report the path. */
  public backupPath(sessionId: SessionId): string {
    return join(this.#directory, `${sessionId}.jsonl`);
  }

  /** Claude Code's own transcript for this session, under the resolved config directory. */
  public transcriptPath(sessionId: SessionId): string {
    return sessionTranscriptPath(sessionId, this.#options.workspaceRoot, this.#configDirectory());
  }

  public async checkpoint(sessionId: SessionId): Promise<TranscriptCheckpointOutcome> {
    return this.#serialize(() => this.#checkpoint(sessionId), "failed");
  }

  /** Applies retention even when no new transcript has just been created. */
  public async prune(): Promise<void> {
    await this.#serialize(async () => {
      const retain = this.#retain();
      if (retain <= 0) {
        await rm(this.#directory, { recursive: true, force: true });
        return;
      }
      await this.#prune(retain);
    }, undefined);
  }

  public async restore(sessionId: SessionId): Promise<TranscriptRestoreOutcome> {
    return this.#serialize(() => this.#restore(sessionId), "failed");
  }

  async #checkpoint(sessionId: SessionId): Promise<TranscriptCheckpointOutcome> {
    const retain = this.#retain();
    if (retain <= 0) return "disabled";
    const source = this.transcriptPath(sessionId);
    const target = this.backupPath(sessionId);
    const liveSize = await size(source);
    if (liveSize === undefined) return "no-source";
    const backupSize = await size(target);
    if (backupSize === undefined) {
      await this.#copy(source, target, liveSize);
      // A new file is the only moment the retained count can grow.
      await this.#prune(retain, target);
      this.#options.log?.(`Backed up Manager transcript ${sessionId} (${liveSize} bytes).`);
      return "copied";
    }
    if (!(await continues(source, target, liveSize, backupSize))) {
      // Same session id, different conversation: the live file is authoritative
      // for that id, and appending would splice two transcripts together.
      await this.#copy(source, target, liveSize);
      this.#options.log?.(`Manager transcript ${sessionId} diverged from its backup; replaced the copy (${liveSize} bytes).`);
      return "copied";
    }
    if (liveSize === backupSize) return "unchanged";
    if (liveSize < backupSize) return "ahead";
    await this.#append(source, target, backupSize, liveSize);
    return "appended";
  }

  async #restore(sessionId: SessionId): Promise<TranscriptRestoreOutcome> {
    if (this.#retain() <= 0) return "disabled";
    const target = this.transcriptPath(sessionId);
    if (await transcriptHoldsConversation(target)) return "live";
    const backup = this.backupPath(sessionId);
    // A metadata-only copy restores nothing `--resume` would accept, and would
    // overwrite a stub with a stub.
    if (!(await transcriptHoldsConversation(backup))) return "no-backup";
    const bytes = (await size(backup)) ?? 0;
    await this.#copy(backup, target, bytes);
    this.#options.log?.(`Restored Manager transcript ${sessionId} from ${backup} (${bytes} bytes); Claude Code's retention sweep had removed it.`);
    return "restored";
  }

  async #copy(source: string, target: string, bytes: number): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await pipeline(createReadStream(source, { start: 0, ...(bytes === 0 ? {} : { end: bytes - 1 }) }), createWriteStream(temporary, { mode: 0o600 }));
      await rm(target, { force: true });
      await rename(temporary, target);
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** Append exactly the bytes the live transcript gained, bounded by the size this checkpoint observed. */
  async #append(source: string, target: string, from: number, to: number): Promise<void> {
    await pipeline(createReadStream(source, { start: from, end: to - 1 }), createWriteStream(target, { flags: "a" }));
  }

  async #prune(retain: number, keepPath?: string): Promise<void> {
    let entries: readonly string[];
    try { entries = await readdir(this.#directory); }
    catch { return; }
    const files = entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(this.#directory, entry));
    if (files.length <= retain) return;
    const dated = await Promise.all(files.map(async (path) => ({ path, at: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0 })));
    const stale = dated.sort((left, right) => right.at - left.at).slice(retain);
    for (const entry of stale) {
      if (entry.path === keepPath) continue;
      await rm(entry.path, { force: true });
      this.#options.log?.(`Pruned Manager transcript backup ${entry.path} (retaining ${retain}).`);
    }
  }

  #retain(): number {
    const value = this.#options.retain?.() ?? DEFAULT_TRANSCRIPT_BACKUPS;
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  #configDirectory(): string {
    return this.#options.configDirectory?.() ?? claudeConfigDirectory();
  }

  async #serialize<T>(operation: () => Promise<T>, onFailure: T): Promise<T> {
    const run = async (): Promise<T> => {
      try { return await operation(); }
      catch (error: unknown) {
        this.#options.log?.(`Manager transcript backup failed: ${error instanceof Error ? error.message : "unknown error"}`);
        return onFailure;
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function size(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats.size : undefined;
  } catch { return undefined; }
}

async function continues(source: string, target: string, liveSize: number, backupSize: number): Promise<boolean> {
  const overlap = Math.min(liveSize, backupSize);
  // One side is empty: whichever holds bytes is trivially a continuation of it.
  if (overlap === 0) return true;
  const window = Math.min(OVERLAP_VERIFY_BYTES, overlap);
  const at = overlap - window;
  const [live, copy] = await Promise.all([readAt(source, at, window), readAt(target, at, window)]);
  return live.equals(copy);
}

async function readAt(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
