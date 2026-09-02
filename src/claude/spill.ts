import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { LaunchPlan, RuntimeFile } from "./launch.js";
import { RuntimeAdmission } from "../runtime/admission.js";

export interface PromptSpillStore {
  write(file: RuntimeFile, root?: string): Promise<string>;
  prepare(plan: LaunchPlan, root?: string): Promise<void>;
  remove?(agentId: string): Promise<void>;
  prune?(retainedAgentIds: ReadonlySet<string>): Promise<void>;
}

export class PromptSpillPathError extends Error {}

export class FileSystemPromptSpillStore implements PromptSpillStore {
  public constructor(
    private readonly projectRoot: string,
    private readonly runtimeRoot: string,
    private readonly hookAssets: { readonly settings: string; readonly script: string },
    private readonly admission: RuntimeAdmission = new RuntimeAdmission(true),
  ) {}

  public async write(file: RuntimeFile, root?: string): Promise<string> {
    return this.admission.run(() => this.#write(file));
  }

  async #write(file: RuntimeFile): Promise<string> {
    const path = this.#resolvePath(file.relativePath);
    await mkdir(dirname(path), { recursive: true });
    // Prompt bodies can carry issue content the user considers private.
    await writeFile(path, file.contents, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  public async prepare(plan: LaunchPlan, root?: string): Promise<void> {
    return this.admission.run(() => this.#prepare(plan, root));
  }

  async #prepare(plan: LaunchPlan, root?: string): Promise<void> {
    const sourceRoot = root ?? this.projectRoot;
    const directory = this.#resolvePath(plan.runtimeDirectory);
    await mkdir(directory, { recursive: true });
    const hookDirectory = join(directory, "scripts");
    const hookScript = join(hookDirectory, "aboard_hook.py");
    await mkdir(hookDirectory, { recursive: true });
    await cp(this.hookAssets.script, hookScript, { force: true });
    const hooks = replaceHookScript(
      JSON.parse(await readFile(this.hookAssets.settings, "utf8")) as unknown,
      hookScript,
    );
    await writeFile(join(directory, "settings.json"), `${JSON.stringify({ hooks }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // `/prototype` is also intercepted from brainstormer terminals (the hook and
    // bridge both admit it there), so a brainstormer bundle must ship it too.
    const skills = plan.agentType === "manager"
      ? ["auto", "brainstorm", "done", "general-purpose", "prototype", "reopen", "review-pr", "update-todo"]
      : plan.agentType === "brainstormer"
        ? ["done", "prototype"]
        : ["done"];
    for (const skill of skills) {
      await cp(join(sourceRoot, ".aboard", "skills", skill), join(directory, ".claude", "skills", skill), {
        recursive: true,
        force: true,
      });
    }
    if (plan.agentDefinition !== undefined) await this.#write(plan.agentDefinition);
    if (plan.wrapperRequest !== undefined) await this.#write(plan.wrapperRequest);
  }

  public async remove(agentId: string): Promise<void> {
    await rm(join(this.runtimeRoot, "agents", agentId), { recursive: true, force: true });
  }

  public async prune(retainedAgentIds: ReadonlySet<string>): Promise<void> {
    let entries: readonly import("node:fs").Dirent[];
    try { entries = await import("node:fs/promises").then(({ readdir }) => readdir(join(this.runtimeRoot, "agents"), { withFileTypes: true })); }
    catch { return; }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !retainedAgentIds.has(entry.name))
      .map((entry) => this.remove(entry.name)));
  }

  #resolvePath(candidate: string): string {
    if (!isAbsolute(candidate)) throw new PromptSpillPathError(`Runtime file path must be absolute: ${candidate}`);
    const root = resolve(this.runtimeRoot);
    const path = resolve(candidate);
    const offset = relative(root, path);
    if (offset === ".." || offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(offset)) {
      throw new PromptSpillPathError(`Runtime file path escapes workspace storage: ${candidate}`);
    }
    return path;
  }
}

function replaceHookScript(value: unknown, script: string): unknown {
  if (value === "__ABOARD_HOOK_SCRIPT__") return script;
  if (Array.isArray(value)) return value.map((entry) => replaceHookScript(entry, script));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceHookScript(entry, script)]));
}
