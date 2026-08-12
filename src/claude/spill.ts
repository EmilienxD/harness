import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { RuntimeFile } from "./launch.js";

/**
 * Persists the files a launch command line reads, under the gitignored runtime
 * directory (spec section 5.1.4): spilled prompts, retained for the session
 * lifetime so a later `--resume` can still resolve their `@` references, and
 * the system prompt file each agent-defined launch and resume points at.
 */
export interface PromptSpillStore {
  /** Writes the file and returns its absolute path. */
  write(file: RuntimeFile): Promise<string>;
}

export class PromptSpillPathError extends Error {}

export class FileSystemPromptSpillStore implements PromptSpillStore {
  public constructor(private readonly workspaceRoot: string) {}

  public async write(file: RuntimeFile): Promise<string> {
    const path = this.#resolvePath(file.relativePath);
    await mkdir(dirname(path), { recursive: true });
    // Prompt bodies can carry issue content the user considers private.
    await writeFile(path, file.contents, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  #resolvePath(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new PromptSpillPathError(`Runtime file path must be workspace-relative: ${relativePath}`);
    }
    const root = resolve(this.workspaceRoot);
    const path = resolve(join(root, relativePath));
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new PromptSpillPathError(`Runtime file path escapes the workspace: ${relativePath}`);
    }
    return path;
  }
}
