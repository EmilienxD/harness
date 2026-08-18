import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
          // `alwaysLoad` keeps the aboard tools out of Claude Code's tool search,
          // so the Manager never has to discover the very surface it orchestrates
          // through.
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

/**
 * The aboard MCP registration, written per Manager launch and pointed at by that
 * launch's `--mcp-config`.
 *
 * Two things decide this shape. **Scope:** `--mcp-config` applies to the one
 * session whose command line carries it, where a `.mcp.json` entry is
 * project-scoped — every worker, every `Explore`, and the user's own
 * hand-started `claude` would connect it and spend context on tool descriptions
 * for a surface the bridge refuses them anyway. **Location:** the file holds a
 * resolved bearer token, so it lives beside `bridge.json` in the extension's own
 * storage rather than anywhere under the workspace, for exactly the reason
 * `bridge.json` was moved out of the tree.
 *
 * The values are resolved rather than left as `${ABOARD_BRIDGE_*}` references.
 * Claude Code expands those in `.mcp.json`-shaped configuration, but the file is
 * read before the wrapper's environment is a factor, and the earlier attempt to
 * carry the same references in the Manager's agent frontmatter proved they are
 * not expanded there at all — the URL reached Claude Code as literal text and
 * the server failed to load. Resolving here has no such ambiguity, and rewriting
 * the file on every launch and resume means a stale port or a token from a
 * previous activation can never be what the Manager connects with.
 *
 * `--strict-mcp-config` is deliberately never passed alongside it: it would
 * silence every MCP server the *user* configured, and aboard's isolation claim
 * is about not imposing its own server on other sessions, not about taking the
 * user's away from the Manager.
 */
export class FileManagerMcpConfig {
  readonly #path: string;

  public constructor(storageDirectory: string) {
    this.#path = join(storageDirectory, MANAGER_MCP_CONFIG_FILE_NAME);
  }

  public get path(): string {
    return this.#path;
  }

  /** Writes the registration and returns the path `--mcp-config` must name. */
  public async write(registration: ManagerMcpRegistration): Promise<string> {
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(temporaryPath, managerMcpConfigDocument(registration), {
      encoding: "utf8",
      mode: 0o600,
    });
    // Windows does not consistently replace an existing destination with rename().
    await rm(this.#path, { force: true });
    await rename(temporaryPath, this.#path);
    return this.#path;
  }

  public async clear(): Promise<void> {
    await rm(this.#path, { force: true });
  }
}
