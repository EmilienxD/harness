/**
 * Where a script that aboard did not launch finds the command endpoint.
 *
 * The bridge's port and full token are deliberately hard to find: they live in
 * VS Code's extension storage, and every process aboard starts inherits them.
 * That is right for the agent surface and useless for the case `/commands`
 * exists to serve — a setup script the user runs from any shell, in a project
 * that may not even be initialized, which has no way to guess an extension
 * storage path.
 *
 * So the endpoint publishes itself: one small record per open window, in a
 * per-user directory outside every workspace, carrying the port and the
 * command-scoped token — never the full one. A script reads the directory, picks
 * the record whose `workspaceRoot` contains its own working directory, and
 * calls. Nothing is written into the user's tree, so nothing can be committed,
 * and no `.aboard/` directory appears before the project has one.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface CommandEndpointRecord {
  readonly version: 1;
  readonly host: "127.0.0.1";
  readonly port: number;
  /** The window's workspace folder: how a script recognizes its own project. */
  readonly workspaceRoot: string;
  readonly commandToken: string;
  /** Extension host process, so a reader can tell a live window from a leftover. */
  readonly pid: number;
  readonly activatedAt: string;
}

export const COMMAND_ENDPOINT_DIRECTORY_NAME = "endpoints";

/**
 * A single deterministic path per platform. Script authors have to reproduce
 * this in whatever language they wrote their setup command in, so the rule they
 * copy stays one line long per platform rather than a search order.
 */
export function commandEndpointDirectory(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string {
  if (platform === "win32") {
    return join(environment.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local"), "aboard", COMMAND_ENDPOINT_DIRECTORY_NAME);
  }
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "aboard", COMMAND_ENDPOINT_DIRECTORY_NAME);
  }
  const state = environment.XDG_STATE_HOME;
  return join(state === undefined || state === "" ? join(homeDirectory, ".local", "state") : state, "aboard", COMMAND_ENDPOINT_DIRECTORY_NAME);
}

/**
 * The file name only has to be stable for one workspace, so a window that
 * reopens replaces its own record instead of accumulating them. Readers match on
 * the record's `workspaceRoot` field and never reproduce this, which keeps path
 * normalization out of the cross-language contract.
 */
function recordFileName(workspaceRoot: string): string {
  const normalized = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return `${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}.json`;
}

export interface CommandEndpointRegistryOptions {
  readonly directory: string;
  /** Defaults to signal-0 probing. A dead pid means a window that never cleaned up. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class FileCommandEndpointRegistry {
  readonly #directory: string;
  readonly #isProcessAlive: (pid: number) => boolean;
  #fileName: string | undefined;

  public constructor(options: CommandEndpointRegistryOptions) {
    this.#directory = options.directory;
    this.#isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  public get directory(): string {
    return this.#directory;
  }

  public async publish(record: CommandEndpointRecord): Promise<string> {
    const fileName = recordFileName(record.workspaceRoot);
    this.#fileName = fileName;
    const path = join(this.#directory, fileName);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#pruneAbandoned(fileName);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Windows does not consistently replace an existing destination with rename().
    await rm(path, { force: true });
    await rename(temporaryPath, path);
    return path;
  }

  public async clear(): Promise<void> {
    if (this.#fileName === undefined) return;
    await rm(join(this.#directory, this.#fileName), { force: true });
    this.#fileName = undefined;
  }

  /**
   * A crashed or force-killed window leaves a record naming a port that is gone
   * or, worse, one another process has since been given. Removing records whose
   * extension host is dead is cheap here and impossible for a script to do
   * safely, so this side does it. Best-effort throughout: a directory that
   * cannot be read is a reason to skip pruning, never to fail the activation.
   */
  async #pruneAbandoned(ownFileName: string): Promise<void> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.#directory);
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry !== ownFileName && entry.endsWith(".json"))
      .map(async (entry) => {
        const path = join(this.#directory, entry);
        try {
          const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
          if (typeof parsed.pid === "number" && this.#isProcessAlive(parsed.pid)) return;
        } catch {
          // Unreadable or unparseable: it can never be used, so it is litter.
        }
        await rm(path, { force: true }).catch(() => undefined);
      }));
  }
}
