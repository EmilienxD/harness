import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { promptSpillRoot, taskPromptPath, type RuntimeFile } from "./launch.js";
import type { AgentId } from "../domain/contracts.js";
import { RuntimeAdmission } from "../runtime/admission.js";
import type { PlatformLaunchPlan, PlatformLifecycleAssets, PromptSpillStore } from "../platform/agent-platform.js";

export class PromptSpillPathError extends Error {}

/** A short root whose atomic creation isolates one extension activation. */
export function createPromptSpillRoot(parent = tmpdir()): Promise<string> {
  return mkdtemp(join(parent, "abd-"));
}

export interface FileSystemPromptSpillStoreOptions {
  readonly admission?: RuntimeAdmission;
  readonly promptRoot?: string;
}

export class FileSystemPromptSpillStore implements PromptSpillStore {
  readonly #admission: RuntimeAdmission;
  readonly #promptRoot: string;

  public constructor(
    _projectRoot: string,
    private readonly runtimeRoot: string,
    private readonly lifecycleAssets: ReadonlyMap<string, PlatformLifecycleAssets>,
    options: FileSystemPromptSpillStoreOptions = {},
  ) {
    this.#admission = options.admission ?? new RuntimeAdmission(true);
    this.#promptRoot = options.promptRoot ?? promptSpillRoot(runtimeRoot);
  }

  public async write(file: RuntimeFile, root?: string): Promise<string> {
    return this.#admission.run(() => this.#write(file, this.#promptDirectory(file.agentId)));
  }

  async #write(file: RuntimeFile, allowedRoot = this.runtimeRoot): Promise<string> {
    const path = this.#resolvePath(file.relativePath, allowedRoot);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Prompt bodies can carry issue content the user considers private.
    await writeFile(path, file.contents, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  public async prepare(plan: PlatformLaunchPlan, root?: string): Promise<void> {
    return this.#admission.run(() => this.#prepare(plan, root));
  }

  async #prepare(plan: PlatformLaunchPlan, _root?: string): Promise<void> {
    const directory = this.#resolvePath(plan.runtimeDirectory);
    await mkdir(directory, { recursive: true });
    const hookDirectory = join(plan.platform === "chatgpt" ? this.runtimeRoot : directory, "scripts");
    const hookScript = join(hookDirectory, "abd_hook.py");
    await mkdir(hookDirectory, { recursive: true });
    const assets = this.lifecycleAssets.get(plan.platform);
    if (assets === undefined) throw new Error(`No lifecycle assets are registered for ${plan.platform}`);
    if (plan.platform === "chatgpt") {
      const contents = await readFile(assets.script);
      const installed = await readFile(hookScript).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!installed?.equals(contents)) {
        // Concurrent launches and live terminals must never see a partial script.
        const temporary = `${hookScript}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, contents, { mode: 0o600 });
          await rename(temporary, hookScript);
        } finally {
          await rm(temporary, { force: true });
        }
      }
    } else {
      await cp(assets.script, hookScript, { force: true });
    }
    const hooks = replaceHookScript(
      JSON.parse(await readFile(assets.settings, "utf8")) as unknown,
      hookScript,
    );
    await writeFile(join(directory, "settings.json"), `${JSON.stringify({ hooks }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    if (plan.guard !== undefined) await this.#write(plan.guard);
    if (plan.wrapperRequest !== undefined) await this.#write(plan.wrapperRequest);
    if (plan.task !== undefined) {
      await this.#write({ ...plan.task, relativePath: this.#taskArchivePath(plan.agentId) });
      await this.#write(plan.task, this.#promptDirectory(plan.agentId));
    }
  }

  public async task(agentId: AgentId): Promise<{ readonly path: string; readonly contents: string } | undefined> {
    return this.#admission.run(async () => {
      let contents: string;
      try { contents = await readFile(this.#taskArchivePath(agentId), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      const path = await this.#write({ agentId, relativePath: taskPromptPath(this.runtimeRoot, agentId, this.#promptRoot), contents }, this.#promptDirectory(agentId));
      return { path: path.replaceAll("\\", "/"), contents };
    });
  }

  #taskArchivePath(agentId: string): string {
    this.#promptDirectory(agentId);
    return join(this.runtimeRoot, "tasks", `${agentId}.md`);
  }

  public async remove(agentId: string): Promise<void> {
    this.#promptDirectory(agentId);
    await Promise.all([
      rm(join(this.runtimeRoot, "agents", agentId), { recursive: true, force: true }),
      rm(join(this.#promptRoot, agentId), { recursive: true, force: true }),
    ]);
  }

  public async prune(retainedAgentIds: ReadonlySet<string>, retainedTaskAgentIds = retainedAgentIds): Promise<void> {
    for (const root of [join(this.runtimeRoot, "agents"), this.#promptRoot]) {
      let entries: readonly import("node:fs").Dirent[];
      try { entries = await readdir(root, { withFileTypes: true }); }
      catch { continue; }
      await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !retainedAgentIds.has(entry.name))
        .map((entry) => this.remove(entry.name)));
    }
    const tasksRoot = join(this.runtimeRoot, "tasks");
    const tasks = await readdir(tasksRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(tasks.filter((name) => name.endsWith(".md") && !retainedTaskAgentIds.has(name.slice(0, -3)))
      .map((name) => rm(join(tasksRoot, name), { force: true })));
  }

  #promptDirectory(agentId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentId)) throw new PromptSpillPathError("Invalid prompt agent id");
    return join(this.#promptRoot, agentId);
  }

  #resolvePath(candidate: string, allowedRoot = this.runtimeRoot): string {
    if (!isAbsolute(candidate)) throw new PromptSpillPathError(`Runtime file path must be absolute: ${candidate}`);
    const root = resolve(allowedRoot);
    const path = resolve(candidate);
    const offset = relative(root, path);
    if (offset === ".." || offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(offset)) {
      throw new PromptSpillPathError(`Runtime file path escapes its storage directory: ${candidate}`);
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
