import { readFile } from "node:fs/promises";

/** An idle Codex TUI has no conversation hook until its first prompt. */
export class IdleProviderStartupUncertainError extends Error {
  public readonly retrySafe = false;
  public constructor() {
    super("The provider has not confirmed startup. Its launch may still be pending; inspect or close the original session before trying again.");
    this.name = "IdleProviderStartupUncertainError";
  }
}

function alive(pid: unknown): pid is number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function record(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Confirm the wrapper's provider child, without inventing a conversation identity. */
export async function waitForIdleProviderStartup(
  lockFile: string,
  isTerminalOpen: () => boolean,
  timeoutMs: number,
  settleMs = 300,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let childPid: number | undefined;
  let observedAt = 0;
  while (Date.now() < deadline) {
    const exit = await record(lockFile.replace(/\.lock$/, ".exit"));
    if (exit !== undefined) {
      if (exit.exitCode === 0 && exit.error === undefined) {
        const cancelled = new Error("The provider was closed before startup completed");
        cancelled.name = "SessionStartCancelledError";
        throw cancelled;
      }
      throw new Error(typeof exit.error === "string" ? exit.error : `The provider exited before startup (code ${String(exit.exitCode ?? "unknown")})`);
    }
    if (!isTerminalOpen()) {
      const cancelled = new Error("The agent terminal was closed before startup completed");
      cancelled.name = "SessionStartCancelledError";
      throw cancelled;
    }
    const marker = await record(lockFile);
    if (alive(marker?.childPid) && alive(marker?.wrapperPid)) {
      if (childPid !== marker.childPid) {
        childPid = marker.childPid;
        observedAt = Date.now();
      }
      if (Date.now() - observedAt >= settleMs) return;
    } else {
      childPid = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, settleMs)));
  }
  throw new IdleProviderStartupUncertainError();
}
