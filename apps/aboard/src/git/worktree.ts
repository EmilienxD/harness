import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitClient } from "./client.js";

interface ProjectOverlayFile {
  readonly source: string;
  readonly target: string;
  readonly repositoryPath: string;
}

export interface ProjectConfigurationOverlayRequest {
  readonly workspaceRoot: string;
  readonly worktreeRoot: string;
  readonly git: GitClient;
}

/** Each platform's project configuration, minus the entries that hold live session state. */
export const PROJECT_CONFIGURATION_ROOTS = [
  { name: ".claude", excludedEntries: ["worktrees"], required: false },
  { name: ".agents", excludedEntries: [], required: false },
  { name: ".codex", excludedEntries: ["sessions", "history.jsonl", "log", "logs", "cache", "tmp"], required: false },
  { name: ".pi", excludedEntries: ["sessions", "history.jsonl", "log", "logs", "cache", "tmp"], required: false },
  { name: ".abd", excludedEntries: [], required: true },
  { name: ".harness", excludedEntries: ["runtime"], required: false },
] as const;

export async function overlayProjectConfiguration(request: ProjectConfigurationOverlayRequest): Promise<void> {
  const files: ProjectOverlayFile[] = [];
  for (const root of PROJECT_CONFIGURATION_ROOTS) {
    const sourceRoot = join(request.workspaceRoot, root.name);
    const targetRoot = join(request.worktreeRoot, root.name);
    const source = await pathStat(sourceRoot);
    if (source === undefined || !source.isDirectory()) {
      if (!root.required) continue;
      throw new RunWorkspaceError(`The project configuration directory at ${sourceRoot} is missing or is not a directory.`);
    }
    await planProjectOverlay(sourceRoot, targetRoot, [root.name], root.excludedEntries, files);
  }

  const paths = files.map((file) => file.repositoryPath);
  const ignored = new Set(await request.git.ignoredPaths(paths));
  const exposed = paths.filter((path) => !ignored.has(path));
  if (exposed.length > 0) {
    throw new RunWorkspaceError(
      `Aboard cannot copy ${exposed.length} local project configuration path(s) because git does not ignore them (${exposed.slice(0, 20).join(", ")}). Ignore the local ${PROJECT_CONFIGURATION_ROOTS.map((root) => root.name).join(", ")} content, or commit it before using worktree mode; otherwise git add -A could publish it.`,
    );
  }

  for (const file of files) {
    await mkdir(dirname(file.target), { recursive: true });
    try {
      await copyFile(file.source, file.target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
}

async function planProjectOverlay(
  sourceDirectory: string,
  targetDirectory: string,
  segments: readonly string[],
  excludedEntries: readonly string[],
  files: ProjectOverlayFile[],
): Promise<void> {
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    // A platform's own worktrees, sessions, and logs are live state rather than
    // project configuration.
    if (segments.length === 1 && excludedEntries.some((excluded) => entry.name.toLowerCase() === excluded.toLowerCase())) continue;
    const nextSegments = [...segments, entry.name];
    const source = join(sourceDirectory, entry.name);
    const target = join(targetDirectory, entry.name);
    const targetEntry = await pathStat(target);
    if (entry.isSymbolicLink()) {
      if (targetEntry !== undefined) continue;
      throw new RunWorkspaceError(
        `The local project configuration entry ${nextSegments.join("/")} is a symbolic link or junction. aboard will not follow links while copying configuration into a checkout.`,
      );
    }
    if (entry.isDirectory()) {
      if (targetEntry !== undefined && !targetEntry.isDirectory()) continue;
      await planProjectOverlay(source, target, nextSegments, excludedEntries, files);
      continue;
    }
    if (!entry.isFile()) {
      if (targetEntry !== undefined) continue;
      throw new RunWorkspaceError(`The local project configuration entry ${nextSegments.join("/")} is not a regular file.`);
    }
    if (targetEntry !== undefined) continue;
    files.push({ source, target, repositoryPath: nextSegments.join("/") });
  }
}

async function pathStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export class RunWorkspaceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RunWorkspaceError";
  }
}

export function runWorkspacePath(options: {
  readonly workspaceRoot: string;
  readonly root?: string;
  /** Also fence a linked source checkout when names are anchored at the main checkout. */
  readonly sourceRoot?: string;
  readonly exists?: (path: string) => boolean;
}): string {
  const workspaceRoot = resolve(options.workspaceRoot);
  const configured = options.root?.trim() ?? "";
  const container = configured.length === 0
    ? dirname(workspaceRoot)
    : isAbsolute(configured) ? resolve(configured) : resolve(workspaceRoot, configured);
  const first = join(container, `${basename(workspaceRoot)}-1`);
  if (!isOutside(first, workspaceRoot) || options.sourceRoot !== undefined && !samePath(first, options.sourceRoot) && !isOutside(first, options.sourceRoot)) {
    throw new RunWorkspaceError(
      `The checkout would be created at ${first}, inside the project at ${workspaceRoot}. Point aboard.autoRun.worktree.root somewhere outside the project.`,
    );
  }
  const exists = options.exists ?? existsSync;
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = join(container, `${basename(workspaceRoot)}-${index}`);
    if (options.sourceRoot !== undefined && !isOutside(candidate, options.sourceRoot)) continue;
    if (!exists(candidate)) return candidate;
  }
  throw new RunWorkspaceError(`Aboard could not find an available checkout name beside ${workspaceRoot}.`);
}

function isOutside(path: string, root: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset.length > 0 && (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset));
}

/** Case-insensitive on Windows, where two spellings of one path are the same path. */
export function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const resolved = resolve(path.replaceAll("/", sep));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** The scaffolded setup command for this platform, relative to the source checkout. */
export function setupCommandPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ".abd/session-setup.ps1" : ".abd/session-setup.sh";
}

export function hasSetupCommands(source: string): boolean {
  let inBlockComment = false;
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("#>")) inBlockComment = false;
      continue;
    }
    if (line.startsWith("<#")) {
      if (!line.includes("#>")) inBlockComment = true;
      continue;
    }
    if (line.length === 0 || line.startsWith("#")) continue;
    return true;
  }
  return false;
}

/** The program and arguments that run the setup file on this platform. */
export function setupCommandLine(script: string, platform: NodeJS.Platform = process.platform): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return platform === "win32"
    ? { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] }
    : { command: "bash", args: [script] };
}

export interface SetupCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface SetupCommandRunner {
  /** Resolves on success; rejects with a reason the user can act on. */
  run(request: SetupCommandRequest): Promise<void>;
}

export const processSetupCommandRunner: SetupCommandRunner = {
  run: (request) => new Promise((resolvePromise, reject) => {
    execFile(
      request.command,
      [...request.args],
      {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        timeout: request.timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        if (error === null) return resolvePromise();
        const detail = typeof stderr === "string" && stderr.trim().length > 0 ? stderr.trim().slice(0, 2_000) : error.message;
        reject(new RunWorkspaceError(detail));
      },
    );
  }),
};
