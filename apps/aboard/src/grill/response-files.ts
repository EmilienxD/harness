import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPlatformId } from "../domain/contracts.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OWNED_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/u;

/** Private, immutable responses survive confirmation, relay disposal, and window reload. */
export class GrillResponseFiles {
  public constructor(private readonly root = join(tmpdir(), `aboard-grill-responses-${createHash("sha256").update(homedir()).digest("hex").slice(0, 16)}`)) {}

  public async write(contents: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.#prune();
    const path = join(this.root, `${randomUUID()}.md`);
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return path;
  }

  async #prune(): Promise<void> {
    const cutoff = Date.now() - RETENTION_MS;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !OWNED_FILE.test(entry.name)) continue;
      const path = join(this.root, entry.name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
      } catch (error) {
        // Another window may have pruned the same expired response.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

/** File-reference syntax, not shell quoting: these paths go into a provider composer. */
export function grillResponseReference(provider: AgentPlatformId, path: string, platform: NodeJS.Platform = process.platform): string {
  if (/["\u0000-\u001f\u007f]/u.test(path)) throw new Error("Grill response path contains unsupported characters");
  const normalized = provider === "chatgpt" && platform === "win32"
    ? path.replaceAll("/", "\\")
    : path.replaceAll("\\", "/");
  const quoted = /\s/u.test(normalized) ? `"${normalized}"` : normalized;
  switch (provider) {
    case "claude": return `@${quoted}`;
    case "chatgpt": return quoted;
    case "pi": return `@${quoted}`;
  }
}
