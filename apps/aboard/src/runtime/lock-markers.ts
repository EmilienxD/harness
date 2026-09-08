import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import type { LockMarkerProbe } from "../bridge/session-lifecycle.js";
import type { SessionWrapperLayout } from "../platform/agent-platform.js";

export const lockMarkerPresent: LockMarkerProbe = (lockFile) => existsSync(lockFile);

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
