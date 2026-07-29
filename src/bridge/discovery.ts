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

export class FileBridgeDiscoveryPersistence
  implements BridgeDiscoveryPersistence
{
  readonly #path: string;

  public constructor(workspaceRoot: string) {
    this.#path = join(workspaceRoot, ".aboard", "runtime", "bridge.json");
  }

  public async write(metadata: BridgeDiscoveryMetadata): Promise<void> {
    const temporaryPath = `${this.#path}.tmp`;
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
