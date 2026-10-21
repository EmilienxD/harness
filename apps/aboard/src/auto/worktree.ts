import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { autoRunMessage, type WorktreeSettings } from "../domain/auto-run.js";
import { isWorkingTreeClean, type GitClient } from "../git/client.js";
import { RunWorkspaceError, overlayProjectConfiguration, runWorkspacePath, samePath, setupCommandPath, hasSetupCommands, setupCommandLine, processSetupCommandRunner, type ProjectConfigurationOverlayRequest, type SetupCommandRunner } from "../git/worktree.js";
export * from "../git/worktree.js";

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

export function isolationProtectedPaths(projectRoot: string): readonly string[] {
  return [resolve(projectRoot)];
}

export async function worktreeGitMetadataRoots(worktreeRoot: string, projectRoot: string): Promise<readonly string[]> {
  const pointer = await readFile(join(worktreeRoot, ".git"), "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/iu.exec(pointer.trim());
  if (match?.[1] === undefined) throw new RunWorkspaceError(`The run checkout at ${worktreeRoot} has no valid linked-worktree .git pointer.`);
  const gitDirectory = resolve(worktreeRoot, match[1]);
  const commonDirectory = resolve(gitDirectory, (await readFile(join(gitDirectory, "commondir"), "utf8")).trim());
  let projectMetadata = join(projectRoot, ".git");
  if ((await stat(projectMetadata)).isFile()) {
    const projectPointer = /^gitdir:\s*(.+?)\s*$/iu.exec((await readFile(projectMetadata, "utf8")).trim());
    if (!projectPointer?.[1]) throw new RunWorkspaceError(`The project at ${projectRoot} has no valid Git pointer.`);
    const projectGitDirectory = resolve(projectRoot, projectPointer[1]);
    projectMetadata = resolve(projectGitDirectory, (await readFile(join(projectGitDirectory, "commondir"), "utf8")).trim());
  }
  if (!samePath(commonDirectory, projectMetadata)) {
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

export interface WorktreeRunWorkspaceOptions {
  readonly workspaceRoot: string;
  /** Main checkout anchors sibling names even when this window is a linked checkout. */
  readonly mainCheckoutRoot?: string;
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
    return runWorkspacePath({ workspaceRoot: this.options.mainCheckoutRoot ?? this.options.workspaceRoot, sourceRoot: this.options.workspaceRoot, root: worktree.root });
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
      workspaceRoot: this.options.mainCheckoutRoot ?? this.options.workspaceRoot,
      sourceRoot: this.options.workspaceRoot,
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
