import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RuntimeAdmission } from "../runtime/admission.js";

import { ABOARD_MCP_SERVER_NAME } from "./mcp-tools.js";

export { ABOARD_MCP_SERVER_NAME };

export const MANAGER_MCP_CONFIG_FILE_NAME = "manager-mcp.json";

export interface ManagerMcpRegistration {
  readonly port: number;
  readonly token: string;
  readonly agentId: string;
}

export function managerMcpConfigDocument(registration: ManagerMcpRegistration): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [ABOARD_MCP_SERVER_NAME]: {
          type: "http",
          url: `http://127.0.0.1:${registration.port}/mcp`,
          alwaysLoad: true,
          headers: {
            Authorization: `Bearer ${registration.token}`,
            "X-Aboard-Agent-Id": registration.agentId,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export class FileManagerMcpConfig {
  readonly #path: string;

  public constructor(storageDirectory: string, private readonly runtimeAdmission: RuntimeAdmission = new RuntimeAdmission(true), private readonly available: () => boolean = () => true) {
    this.#path = join(storageDirectory, MANAGER_MCP_CONFIG_FILE_NAME);
  }

  public get path(): string {
    return this.#path;
  }

  /** Writes the registration and returns the path `--mcp-config` must name. */
  public async write(registration: ManagerMcpRegistration): Promise<string> {
    if (!this.available()) throw new Error("aboard runtime is not initialized");
    return this.runtimeAdmission.run(() => this.#write(registration));
  }
  async #write(registration: ManagerMcpRegistration): Promise<string> {
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(temporaryPath, managerMcpConfigDocument(registration), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (!this.available()) {
      await rm(temporaryPath, { force: true });
      throw new Error("aboard runtime reset while preparing Manager MCP configuration");
    }
    // Windows does not consistently replace an existing destination with rename().
    await rm(this.#path, { force: true });
    await rename(temporaryPath, this.#path);
    return this.#path;
  }

  public async clear(): Promise<void> {
    await rm(this.#path, { force: true });
  }
}
