import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { LaunchPlan, RuntimeFile } from "./launch.js";
import { RuntimeAdmission } from "../runtime/admission.js";

export interface PromptSpillStore {
  write(file: RuntimeFile, root?: string): Promise<string>;
  prepare(plan: LaunchPlan, root?: string): Promise<void>;
}

export class PromptSpillPathError extends Error {}

export class FileSystemPromptSpillStore implements PromptSpillStore {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly admission: RuntimeAdmission = new RuntimeAdmission(true),
  ) {}

  public async write(file: RuntimeFile, root?: string): Promise<string> {
    return this.admission.run(() => this.#write(file, root));
  }

  async #write(file: RuntimeFile, root?: string): Promise<string> {
    const path = this.#resolvePath(file.relativePath, root ?? this.workspaceRoot);
    await mkdir(dirname(path), { recursive: true });
    // Prompt bodies can carry issue content the user considers private.
    await writeFile(path, file.contents, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  public async prepare(plan: LaunchPlan, root?: string): Promise<void> {
    return this.admission.run(() => this.#prepare(plan, root));
  }

  async #prepare(plan: LaunchPlan, root?: string): Promise<void> {
    const base = root ?? this.workspaceRoot;
    const directory = this.#resolvePath(plan.runtimeDirectory, base);
    await mkdir(directory, { recursive: true });
    const hooks: unknown = JSON.parse(await readFile(join(base, ".aboard", "aboard-hooks.json"), "utf8"));
    await writeFile(join(directory, "settings.json"), `${JSON.stringify({ hooks }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const skills = plan.agentType === "manager"
      ? ["auto", "brainstorm", "done", "general-purpose", "reopen", "review-pr", "update-todo"]
      : ["done"];
    for (const skill of skills) {
      await cp(join(base, ".aboard", "skills", skill), join(directory, ".claude", "skills", skill), {
        recursive: true,
        force: true,
      });
    }
    if (plan.agentDefinition !== undefined) await this.#write(plan.agentDefinition, base);
  }

  #resolvePath(relativePath: string, base: string): string {
    if (isAbsolute(relativePath)) {
      throw new PromptSpillPathError(`Runtime file path must be workspace-relative: ${relativePath}`);
    }
    const root = resolve(base);
    const path = resolve(join(root, relativePath));
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new PromptSpillPathError(`Runtime file path escapes the workspace: ${relativePath}`);
    }
    return path;
  }
}
