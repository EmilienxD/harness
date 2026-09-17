
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { autoRunMessage, type WorktreeSettings } from "../domain/auto-run.js";
import { isWorkingTreeClean, type GitClient } from "../git/client.js";

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
      `The run cannot copy ${exposed.length} local project configuration path(s) because git does not ignore them (${exposed.slice(0, 20).join(", ")}). Ignore the local ${PROJECT_CONFIGURATION_ROOTS.map((root) => root.name).join(", ")} content, or commit it before using worktree mode; otherwise git add -A could publish it.`,
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
        `The local project configuration entry ${nextSegments.join("/")} is a symbolic link or junction. aboard will not follow links while copying configuration into a run checkout.`,
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

/** Where a run's issue branches are checked out and its agents are launched. */
export interface RunWorkspace {
  /** Absolute path every agent of this run runs in. */
  readonly root: string;
  /** git bound to `root`. Every phase's side effects go through it. */
  readonly git: GitClient;
  readonly protectedPaths: readonly string[];
  /** Git metadata roots a sandboxed worker needs for its allowed add/commit. */
  readonly writableRoots: readonly string[];
  /** Whether `root` is a checkout this run created and may remove. */
  readonly isolated: boolean;
  /** Frozen cleanup policy for an isolated checkout after the run drains. */
  readonly keepAfterDrain: boolean;
}

export interface RunWorkspaceRequest {
  readonly runId: string;
  readonly sessionBranch: string;
  readonly base: string;
  /** The checkout path frozen in the run record before any Git side effects. */
  readonly checkoutRoot?: string;
  readonly worktree?: WorktreeSettings;
  /** The persisted run record confirms that this checkout finished preparation. */
  readonly prepared?: boolean;
}

/** How a run ended, as far as its checkout is concerned. */
export type RunWorkspaceOutcome =
  /** Nothing is left for the user to look at in it. */
  | "drained"
  /** Stopped, parked, or aborted: terminals and half-finished work are in there. */
  | "interrupted";

/** A checkout that outlived its run, and why the user is being told about it. */
export interface KeptRunWorkspace {
  readonly path: string;
  readonly reason: "kept-by-setting" | "left-for-the-user" | "removal-failed";
}

export interface RunWorkspaceProvider {
  isolates(): boolean;
  /** Chooses an unused path that can be frozen into a new run record. */
  nextRoot(worktree: WorktreeSettings): string;
  /** Creates or re-attaches the run's checkout, with the session branch on it. */
  prepare(request: RunWorkspaceRequest): Promise<RunWorkspace>;
  release(workspace: RunWorkspace, outcome: RunWorkspaceOutcome): Promise<KeptRunWorkspace | undefined>;
  /** Removes a clean recorded checkout after restart, when no live workspace object exists. */
  removeRecorded?(root: string): Promise<boolean>;
}

export function runWorkspacePath(options: {
  readonly workspaceRoot: string;
  readonly root?: string;
  readonly exists?: (path: string) => boolean;
}): string {
  const workspaceRoot = resolve(options.workspaceRoot);
  const configured = options.root?.trim() ?? "";
  const container = configured.length === 0
    ? dirname(workspaceRoot)
    : isAbsolute(configured) ? resolve(configured) : resolve(workspaceRoot, configured);
  const first = join(container, `${basename(workspaceRoot)}-1`);
  if (!isOutside(first, workspaceRoot)) {
    throw new RunWorkspaceError(
      `The run's checkout would be created at ${first}, inside the project at ${workspaceRoot}. Point aboard.autoRun.worktree.root somewhere outside the project.`,
    );
  }
  const exists = options.exists ?? existsSync;
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = join(container, `${basename(workspaceRoot)}-${index}`);
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

export function isolationProtectedPaths(projectRoot: string): readonly string[] {
  return [resolve(projectRoot)];
}

export async function worktreeGitMetadataRoots(worktreeRoot: string, projectRoot: string): Promise<readonly string[]> {
  const pointer = await readFile(join(worktreeRoot, ".git"), "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/iu.exec(pointer.trim());
  if (match?.[1] === undefined) throw new RunWorkspaceError(`The run checkout at ${worktreeRoot} has no valid linked-worktree .git pointer.`);
  const gitDirectory = resolve(worktreeRoot, match[1]);
  const commonDirectory = resolve(gitDirectory, (await readFile(join(gitDirectory, "commondir"), "utf8")).trim());
  if (!samePath(commonDirectory, join(projectRoot, ".git"))) {
    throw new RunWorkspaceError(`The run checkout at ${worktreeRoot} points outside the project's Git metadata.`);
  }
  return [
    gitDirectory,
    join(commonDirectory, "objects"),
    join(commonDirectory, "refs", "heads"),
    join(commonDirectory, "logs", "refs", "heads"),
    join(commonDirectory, "packed-refs"),
    join(commonDirectory, "packed-refs.lock"),
  ];
}

/** The scaffolded setup command for this platform, relative to the project root. */
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

export interface WorktreeRunWorkspaceOptions {
  readonly workspaceRoot: string;
  /** git bound to the project root; the only client that may add or remove a checkout. */
  readonly git: GitClient;
  /** A git client bound to another directory, for the checkout this creates. */
  readonly gitFor: (cwd: string) => GitClient;
  readonly settings: () => WorktreeSettings;
  readonly notify: (message: string) => void;
  readonly log?: (message: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly setup?: SetupCommandRunner;
  readonly readSetupFile?: (path: string) => Promise<string | undefined>;
  readonly overlayProjectConfiguration?: (request: ProjectConfigurationOverlayRequest) => Promise<void>;
  readonly resolveGitMetadataRoots?: (worktreeRoot: string, projectRoot: string) => Promise<readonly string[]>;
  readonly directories?: RunWorkspaceDirectories;
  /**
   * Asks the provider this run will launch whether it can natively fence workers
   * out of these paths. An unrepresentable path must fail closed before the
   * checkout exists, because an interrupted run leaves its checkout behind.
   */
  readonly requireEnforceableIsolation?: (protectedPaths: readonly string[]) => Promise<void> | void;
}

/** The filesystem operations the provider performs, injectable for tests. */
export interface RunWorkspaceDirectories {
  exists(path: string): Promise<boolean>;
  create(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const nodeDirectories: RunWorkspaceDirectories = {
  exists: async (path) => { try { await stat(path); return true; } catch { return false; } },
  create: async (path) => { await mkdir(path, { recursive: true }); },
  remove: (path) => rm(path, { recursive: true, force: true }),
};

export class WorktreeRunWorkspaces implements RunWorkspaceProvider {
  readonly #directories: RunWorkspaceDirectories;
  readonly #platform: NodeJS.Platform;
  readonly #setup: SetupCommandRunner;
  readonly #readSetupFile: (path: string) => Promise<string | undefined>;
  readonly #overlayProjectConfiguration: (request: ProjectConfigurationOverlayRequest) => Promise<void>;
  readonly #resolveGitMetadataRoots: (worktreeRoot: string, projectRoot: string) => Promise<readonly string[]>;

  public constructor(private readonly options: WorktreeRunWorkspaceOptions) {
    this.#directories = options.directories ?? nodeDirectories;
    this.#platform = options.platform ?? process.platform;
    this.#setup = options.setup ?? processSetupCommandRunner;
    this.#readSetupFile = options.readSetupFile
      ?? (async (path) => { try { return await readFile(path, "utf8"); } catch { return undefined; } });
    this.#overlayProjectConfiguration = options.overlayProjectConfiguration ?? overlayProjectConfiguration;
    this.#resolveGitMetadataRoots = options.resolveGitMetadataRoots ?? worktreeGitMetadataRoots;
  }

  public isolates(): boolean {
    return this.options.settings().enabled;
  }

  async #requireEnforceableIsolation(protectedPaths: readonly string[]): Promise<void> {
    const require = this.options.requireEnforceableIsolation;
    if (require === undefined) return;
    try {
      await require(protectedPaths);
    } catch (error) {
      throw new RunWorkspaceError(
        `Aboard cannot isolate this run from ${protectedPaths.join(", ")}: ${error instanceof Error ? error.message : "the agent platform rejected the restriction"}`,
      );
    }
  }

  public nextRoot(worktree: WorktreeSettings): string {
    return runWorkspacePath({ workspaceRoot: this.options.workspaceRoot, root: worktree.root });
  }

  public async prepare(request: RunWorkspaceRequest): Promise<RunWorkspace> {
    const settings = request.worktree ?? this.options.settings();
    if (!settings.enabled) {
      return {
        root: this.options.workspaceRoot,
        git: this.options.git,
        protectedPaths: [],
        writableRoots: [],
        isolated: false,
        keepAfterDrain: false,
      };
    }
    const protectedPaths = isolationProtectedPaths(this.options.workspaceRoot);
    await this.#requireEnforceableIsolation(protectedPaths);
    const path = request.checkoutRoot ?? runWorkspacePath({
      workspaceRoot: this.options.workspaceRoot,
      root: settings.root,
    });
    const created = await this.#checkout(path, request);
    try {
      if (created) {
        await this.#overlayProjectConfiguration({
          workspaceRoot: this.options.workspaceRoot,
          worktreeRoot: path,
          git: this.options.gitFor(path),
        });
        await this.#runSetup(path, request, settings.setupTimeoutSeconds);
      }
      await this.#requireCleanCheckout(path, created);
    } catch (error) {
      if (created) await this.#discardFailedCheckout(path);
      throw error;
    }
    this.options.notify(autoRunMessage.workspace(path));
    return {
      root: path,
      git: this.options.gitFor(path),
      protectedPaths,
      writableRoots: await this.#resolveGitMetadataRoots(path, this.options.workspaceRoot),
      isolated: true,
      keepAfterDrain: settings.keep,
    };
  }

  public async release(workspace: RunWorkspace, outcome: RunWorkspaceOutcome): Promise<KeptRunWorkspace | undefined> {
    if (!workspace.isolated) return undefined;
    if (workspace.keepAfterDrain) return { path: workspace.root, reason: "kept-by-setting" };
    if (outcome === "interrupted") return { path: workspace.root, reason: "left-for-the-user" };
    try {
      await this.options.git.removeWorktree(workspace.root, true);
    } catch (error) {
      // Routine on Windows, where a shell whose current directory is inside the
      // checkout holds it open for as long as it takes to notice it was killed.
      this.options.log?.(`auto-run could not remove its checkout at ${workspace.root}: ${describe(error)}`);
      return { path: workspace.root, reason: "removal-failed" };
    }
    await this.#directories.remove(workspace.root).catch(() => undefined);
    return undefined;
  }

  public async removeRecorded(root: string): Promise<boolean> {
    const registered = (await this.options.git.worktrees()).some((worktree) => samePath(worktree.path, root));
    if (!registered) return false;
    if (!isWorkingTreeClean(await this.options.gitFor(root).status())) return false;
    await this.options.git.removeWorktree(root, true);
    await this.#directories.remove(root).catch(() => undefined);
    return true;
  }

  /** Creates the checkout, or re-attaches to the one a previous attempt made. */
  async #checkout(path: string, request: RunWorkspaceRequest): Promise<boolean> {
    const existing = (await this.options.git.worktrees()).find((worktree) => samePath(worktree.path, path));
    if (existing !== undefined) {
      if (existing.branch !== request.sessionBranch) {
        const actual = existing.branch ?? "a detached HEAD";
        throw new RunWorkspaceError(
          `${path} is already registered for ${actual}, not this run's session branch ${request.sessionBranch}. Remove it, or point aboard.autoRun.worktree.root elsewhere.`,
        );
      }
      if (request.prepared === true) return false;
      await this.options.git.removeWorktree(path, true).catch((error: unknown) => {
        throw new RunWorkspaceError(
          `The incomplete run checkout at ${path} could not be removed before setup was retried: ${describe(error)}`,
        );
      });
      await this.#directories.remove(path).catch(() => undefined);
    }
    if (await this.#directories.exists(path)) {
      throw new RunWorkspaceError(
        `${path} already exists and is not a checkout of this repository. Remove it, or point aboard.autoRun.worktree.root elsewhere.`,
      );
    }
    await this.#directories.create(dirname(path));
    await this.options.git.fetch();
    if (await this.options.git.branchExists(request.sessionBranch)) {
      await this.options.git.addWorktree(path, request.sessionBranch);
      return true;
    }
    // The user's local branch is the run's source of truth, including commits
    // not published yet. Fall back to the remote only for a detached checkout
    // whose resolved default branch has no local ref.
    const startPoint = await this.options.git.branchExists(request.base)
      ? request.base
      : `origin/${request.base}`;
    await this.options.git.addWorktree(path, request.sessionBranch, startPoint);
    return true;
  }

  async #discardFailedCheckout(path: string): Promise<void> {
    try {
      await this.options.git.removeWorktree(path, true);
      await this.#directories.remove(path).catch(() => undefined);
    } catch (error) {
      this.options.log?.(`auto-run could not remove its incomplete checkout at ${path}: ${describe(error)}`);
    }
  }

  async #runSetup(path: string, request: RunWorkspaceRequest, setupTimeoutSeconds: number): Promise<void> {
    const relativePath = setupCommandPath(this.#platform);
    // The project root's copy, not the checkout's: the user edits the former,
    // while the latter is whatever the session branch happens to carry.
    const script = join(this.options.workspaceRoot, ...relativePath.split("/"));
    const source = await this.#readSetupFile(script);
    if (source === undefined || !hasSetupCommands(source)) return;
    const { command, args } = setupCommandLine(script, this.#platform);
    this.options.notify(autoRunMessage.setup(relativePath));
    const timeoutMs = Math.max(1, setupTimeoutSeconds) * 1_000;
    try {
      await this.#setup.run({
        command,
        args,
        cwd: path,
        env: {
          ABOARD_SESSION_PATH: path,
          ABOARD_PROJECT_ROOT: this.options.workspaceRoot,
          ABOARD_SESSION_BRANCH: request.sessionBranch,
          ABOARD_RUN_ID: request.runId,
        },
        timeoutMs,
      });
    } catch (error) {
      throw new RunWorkspaceError(`${relativePath} failed in the run's checkout at ${path}: ${describe(error)}`);
    }
  }

  async #requireCleanCheckout(path: string, created: boolean): Promise<void> {
    // Only a checkout this attempt created has to be clean. A resumed run's may
    // legitimately hold an address worker's uncommitted work.
    if (!created) return;
    const status = await this.options.gitFor(path).status();
    if (status.entries.length === 0) return;
    const paths = status.entries.map((entry) => entry.path);
    throw new RunWorkspaceError(
      `${setupCommandPath(this.#platform)} left ${paths.length} uncommitted path(s) in the run's checkout (${paths.slice(0, 20).join(", ")}). Add them to .gitignore, or the run would commit them to the first issue's branch`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
