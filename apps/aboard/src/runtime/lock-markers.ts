import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import type { LockMarkerProbe } from "../bridge/session-lifecycle.js";
import type { SessionWrapperLayout } from "../platform/agent-platform.js";

export const lockMarkerPresent: LockMarkerProbe = (lockFile) => existsSync(lockFile);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process owned by another user answers EPERM: it exists, and it is not ours to judge.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a marker still stands for a running execution. A wrapper killed outright
 * (terminal closed from the title bar, machine reset) leaves its marker behind, and
 * that stale file must not refuse a continuation forever. The recorded identities
 * settle it; without them the marker itself is the only evidence available.
 */
export function lockMarkerLive(lockFile: string): boolean {
  let raw: string;
  try { raw = readFileSync(lockFile, "utf8"); } catch { return false; }
  try {
    const parsed: unknown = JSON.parse(raw);
    const value = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { wrapperPid?: unknown; childPid?: unknown };
    const pids = [value.wrapperPid, value.childPid].filter((pid): pid is number => typeof pid === "number" && pid > 0);
    return pids.length === 0 || pids.some(processAlive);
  } catch {
    return true;
  }
}

/** The extension-owned wrapper and its markers live outside the user's repository. */
export function sessionWrapperLayout(runtimeRoot: string, wrapperScript: string): SessionWrapperLayout {
  return {
    script: wrapperScript,
    lockPathFor: (agentId) => join(runtimeRoot, "locks", `${agentId}.lock`),
    mintLaunchCode: () => randomUUID(),
  };
}

export function lockMarkerDirectory(runtimeRoot: string): string {
  return join(runtimeRoot, "locks");
}

/** What the wrapper recorded about its child's ending. */
export interface SessionExitRecord {
  /** Null when the wrapper itself was killed before it could observe an exit. */
  readonly exitCode: number | null;
  /** Present when the command could not be spawned at all. */
  readonly error?: string;
}

/** Human-readable evidence that a proven agent process ended abnormally. */
export function sessionExitFailure(exit: SessionExitRecord | undefined): string | undefined {
  if (exit?.error !== undefined) return `the configured agent command could not be started (${exit.error})`;
  if (exit?.exitCode !== undefined && exit.exitCode !== null && exit.exitCode !== 0) return `the agent process exited with code ${exit.exitCode}`;
  return undefined;
}

/** Failure evidence for a process that ended before its first lifecycle start. */
export function sessionLaunchFailure(exit: SessionExitRecord | undefined): string | undefined {
  if (exit?.error !== undefined) return `could not be started (${exit.error})`;
  if (exit?.exitCode === 0) return undefined;
  return `exited with code ${exit?.exitCode ?? "unknown"} before starting a session`;
}

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
