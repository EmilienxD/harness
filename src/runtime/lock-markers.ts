import { existsSync, readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import type { LockMarkerProbe } from "../bridge/session-lifecycle.js";
import type { SessionWrapperLayout } from "../claude/launch.js";

/**
 * Liveness probe for the SessionProcessMonitor: the wrapper's marker exists
 * while its Claude child runs and is removed the moment the child exits for
 * any reason. A missing wrapper (crash before spawn) leaves no marker, which
 * reads as ended — matching the startup-proof failure the launch path turns
 * into a killed terminal.
 */
export const lockMarkerPresent: LockMarkerProbe = (lockFile) => existsSync(lockFile);

/** `.aboard/scripts/aboard_wrapper.py` is extension-owned scaffold state; markers live under gitignored runtime state. */
export function sessionWrapperLayout(workspaceRoot: string): SessionWrapperLayout {
  return {
    script: join(workspaceRoot, ".aboard", "scripts", "aboard_wrapper.py"),
    lockPathFor: (agentId) => join(workspaceRoot, ".aboard", "runtime", "locks", `${agentId}.lock`),
  };
}

export function lockMarkerDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, ".aboard", "runtime", "locks");
}

/** What the wrapper recorded about its child's ending. */
export interface SessionExitRecord {
  /** Null when the wrapper itself was killed before it could observe an exit. */
  readonly exitCode: number | null;
  /** Present when the command could not be spawned at all. */
  readonly error?: string;
}

/**
 * Reads and consumes the wrapper's exit record for a marker. Consuming it keeps
 * a stale record from being attributed to a later launch of the same agent, and
 * the absence of a record is normal — an unwrapped launch, or a wrapper killed
 * outright — so it answers `undefined` rather than throwing.
 */
export function takeSessionExitRecord(lockFile: string): SessionExitRecord | undefined {
  const path = `${lockFile.replace(/\.lock$/, "")}.exit`;
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return undefined; }
  try { rmSync(path, { force: true }); } catch { /* a leftover record is harmless */ }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = parsed as { exitCode?: unknown; error?: unknown };
    return {
      exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
      ...(typeof value.error === "string" && value.error.length > 0 ? { error: value.error } : {}),
    };
  } catch { return undefined; }
}

/**
 * Marker removal as an event rather than a poll interval. Polling alone made a
 * session death take up to a full interval to surface — long enough for the
 * user to see a dead agent still listed and be refused a relaunch. The wrapper
 * deletes its marker the instant its Claude child exits, so a directory watch
 * turns double-Ctrl+C into a sub-second settlement and leaves the poll as the
 * fallback for filesystems where `fs.watch` is unreliable (network shares, some
 * containers).
 *
 * Events are coalesced: an editor or the wrapper can produce several per write,
 * and the sweep they trigger is a handful of `existsSync` calls.
 *
 * The watch never creates the directory: `.aboard/` exists only once the user
 * scaffolds the project, and an activation in an uninitialized workspace must
 * leave the tree untouched. Until the directory appears the watch simply
 * retries, and the poll fallback covers liveness in the meantime.
 */
export function watchLockMarkers(directory: string, onChanged: () => void, debounceMs = 40, retryMs = 2000): { dispose(): void } {
  let pending: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  let disposed = false;

  const schedule = (): void => {
    if (pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      onChanged();
    }, debounceMs);
    pending.unref?.();
  };

  const scheduleRetry = (): void => {
    if (disposed || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      attach();
    }, retryMs);
    retry.unref?.();
  };

  const attach = (): void => {
    if (disposed || watcher !== undefined) return;
    try {
      watcher = watch(directory, { persistent: false }, () => schedule());
    } catch {
      scheduleRetry();
      return;
    }
    // A watch that dies (directory replaced, handle limit) must not take the
    // extension with it; the poll fallback still covers liveness.
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
      scheduleRetry();
    });
  };

  attach();

  return {
    dispose: () => {
      disposed = true;
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      watcher?.close();
      watcher = undefined;
    },
  };
}
