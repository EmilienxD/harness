import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface BridgeDiscoveryMetadata {
  readonly version: 1;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly token: string;
  readonly activatedAt: string;
}

export interface BridgeDiscoveryPersistence {
  write(metadata: BridgeDiscoveryMetadata): Promise<void>;
  clear(): Promise<void>;
}

export const DISCOVERY_FILE_NAME = "bridge.json";

/**
 * The discovery file lives outside the workspace, in the extension's
 * per-workspace storage. Nothing in the project reads it — the hooks and the
 * MCP registration receive the port and token through inherited `ABOARD_BRIDGE_*`
 * environment variables — so writing it into the project only leaked a
 * bearer-token file into the user's tree and made `.aboard/` exist before the
 * project was ever initialized. `.vscode/` would be worse: it is routinely
 * committed.
 */
export class FileBridgeDiscoveryPersistence
  implements BridgeDiscoveryPersistence
{
  readonly #path: string;

  public constructor(storageDirectory: string) {
    this.#path = join(storageDirectory, DISCOVERY_FILE_NAME);
  }

  public get path(): string {
    return this.#path;
  }

  public async write(metadata: BridgeDiscoveryMetadata): Promise<void> {
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // Windows does not consistently replace an existing destination with rename().
    await rm(this.#path, { force: true });
    await rename(temporaryPath, this.#path);
  }

  public async clear(): Promise<void> {
    await rm(this.#path, { force: true });
  }
}
