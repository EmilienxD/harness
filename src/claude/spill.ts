import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { PromptSpillFile } from "./launch.js";

/**
 * Persists spilled prompts under the gitignored runtime directory (spec section
 * 5.1.4). Files are retained for the session lifetime so a later `--resume` can
 * still resolve their `@` references.
 */
export interface PromptSpillStore {
  /** Writes the spill and returns its absolute path. */
  write(spill: PromptSpillFile): Promise<string>;
}

export class PromptSpillPathError extends Error {}

export class FileSystemPromptSpillStore implements PromptSpillStore {
  public constructor(private readonly workspaceRoot: string) {}

  public async write(spill: PromptSpillFile): Promise<string> {
    const path = this.#resolvePath(spill.relativePath);
    await mkdir(dirname(path), { recursive: true });
    // Prompt bodies can carry issue content the user considers private.
    await writeFile(path, spill.contents, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  #resolvePath(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new PromptSpillPathError(`Spill path must be workspace-relative: ${relativePath}`);
    }
    const root = resolve(this.workspaceRoot);
    const path = resolve(join(root, relativePath));
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new PromptSpillPathError(`Spill path escapes the workspace: ${relativePath}`);
    }
    return path;
  }
}
