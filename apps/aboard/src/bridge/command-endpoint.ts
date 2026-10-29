
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, posix, win32 } from "node:path";

export interface CommandEndpointRecord {
  readonly version: 2;
  readonly host: "127.0.0.1";
  readonly port: number;
  /** The window's workspace folder: how a script recognizes its own project. */
  readonly workspaceRoot: string;
  readonly commandToken: string;
  /** Capability for creating manual delegated agents, and no other route. */
  readonly delegationToken: string;
  /** Extension host process, so a reader can tell a live window from a leftover. */
  readonly pid: number;
  readonly activatedAt: string;
}

export type DelegationEndpointRecord = Omit<CommandEndpointRecord, "commandToken">;

export const COMMAND_ENDPOINT_DIRECTORY_NAME = "endpoints";

export function commandEndpointDirectory(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string {
  if (platform === "win32") {
    return join(environment.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local"), "abd", COMMAND_ENDPOINT_DIRECTORY_NAME);
  }
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "abd", COMMAND_ENDPOINT_DIRECTORY_NAME);
  }
  const state = environment.XDG_STATE_HOME;
  return join(state === undefined || state === "" ? join(homeDirectory, ".local", "state") : state, "abd", COMMAND_ENDPOINT_DIRECTORY_NAME);
}

export function normalizeProjectPath(workspaceRoot: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix;
  const normalized = paths.resolve(workspaceRoot).replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function recordFileName(activationId: string): string {
  return `${createHash("sha256").update(activationId, "utf8").digest("hex").slice(0, 32)}.json`;
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
  readonly #activationId = randomUUID();

  public constructor(options: CommandEndpointRegistryOptions) {
    this.#directory = options.directory;
    this.#isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  public get directory(): string {
    return this.#directory;
  }

  public async publish(record: CommandEndpointRecord | DelegationEndpointRecord): Promise<string> {
    // Each activation owns its record, including across overlapping reloads.
    const fileName = recordFileName(this.#activationId);
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

  /** Only prune abandoned records. A project can belong to several live windows. */
  public async clearWorkspace(workspaceRoot: string): Promise<void> {
    void workspaceRoot;
    await this.#pruneAbandoned(this.#fileName ?? "");
  }

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
