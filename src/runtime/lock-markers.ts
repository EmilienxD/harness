import { existsSync } from "node:fs";
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
