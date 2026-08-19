/**
 * The checkout a run works in (`AGENTS.md`).
 *
 * By default a run implements issues in the user's own working tree, which is
 * why it has to move HEAD, why it demands a clean tree before it starts, and why
 * the user cannot touch the repository while it works. This module is the other
 * option: the run gets a checkout of its own, outside the project directory
 * entirely, and the user's tree is never read, written, or moved.
 *
 * Three things make that checkout worth having:
 *
 * - It is a *sibling* of the project root, never a directory inside it. A
 *   checkout nested in the repository is one the run would then address issues
 *   into, and one `git add -A` would try to commit.
 * - It is not named after what it is. An agent that recognizes a second checkout
 *   can reason its way back to "the real repository is elsewhere"; one that sees
 *   an ordinary project directory has no reason to look. This is the cheapest and
 *   most effective part of the isolation, and it is why nothing in the path says
 *   worktree.
 * - Its launches carry `Read`/`Edit` deny rules covering the project root, so the
 *   file tools refuse the user's checkout even if an agent goes looking. That is
 *   defence in depth and nothing more: `Bash` reaches the whole filesystem, and
 *   fencing off shell commands would mean guessing at every command that can
 *   write a file. An agent that means to escape can; this stops the accident.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { autoRunMessage, type WorktreeSettings } from "../domain/auto-run.js";
import type { GitClient } from "../git/client.js";

/**
 * The directory the run's checkouts are collected in, beside the project rather
 * than inside it. Its name is deliberately dull.
 */
export const RUN_WORKSPACE_CONTAINER = ".aboard-sessions";

/**
 * Files an agent's session needs that only exist in a second checkout if they
 * are committed. Both carry the hook registration that reports a worker's
 * result: `${CLAUDE_PROJECT_DIR}` resolves to the session's own directory, so an
 * uncommitted `.claude/settings.json` means a run whose workers never report
 * anything and are killed by the startup-proof timeout instead.
 */
export const REQUIRED_TRACKED_PATHS = [".claude/settings.json", ".claude/hooks/aboard_hook.py"] as const;

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
  /**
   * Permission deny rules fencing this run's agents out of the user's checkout.
   * Empty when the run works in that checkout itself.
   */
  readonly denyTools: readonly string[];
  /** Whether `root` is a checkout this run created and may remove. */
  readonly isolated: boolean;
}

export interface RunWorkspaceRequest {
  readonly runId: string;
  readonly sessionBranch: string;
  readonly base: string;
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
  /**
   * Whether the next run would get a checkout of its own. Asked before one
   * exists, by the preconditions — which is the difference between "the tree the
   * run stages from must be clean" and "the user's tree is none of its
   * business".
   */
  isolates(): boolean;
  /** Creates or re-attaches the run's checkout, with the session branch on it. */
  prepare(request: RunWorkspaceRequest): Promise<RunWorkspace>;
  /**
   * Best-effort teardown. Never throws, and describes the checkout when it was
   * kept, so the caller can tell the user where their work is and why.
   */
  release(workspace: RunWorkspace, outcome: RunWorkspaceOutcome): Promise<KeptRunWorkspace | undefined>;
}

/**
 * The run's own checkout path, derived from the run id rather than stored: a
 * resumed run finds the same directory by computing it again, and a second copy
 * of it could only disagree with the record's run id.
 *
 * The leaf is named after the repository, so the checkout looks like an ordinary
 * clone of the project from the inside.
 */
export function runWorkspacePath(options: {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly root?: string;
}): string {
  const workspaceRoot = resolve(options.workspaceRoot);
  const configured = options.root?.trim() ?? "";
  const container = configured.length === 0
    ? join(dirname(workspaceRoot), RUN_WORKSPACE_CONTAINER)
    : isAbsolute(configured) ? resolve(configured) : resolve(workspaceRoot, configured);
  const path = join(container, options.runId, basename(workspaceRoot));
  // A checkout inside the project is one the run would address issues in and
  // `git add -A` would then try to commit. The setting is the user's, so this is
  // checked rather than assumed.
  if (!isOutside(path, workspaceRoot)) {
    throw new RunWorkspaceError(
      `The run's checkout would be created at ${path}, inside the project at ${workspaceRoot}. Point aboard.autoRun.worktree.root somewhere outside the project.`,
    );
  }
  return path;
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

/**
 * Deny rules covering the user's checkout, in the `//absolute` spelling
 * `Read`/`Edit` rules use (`docs/CLAUDE-REFERENCES/settings.md`). A `Read` denial
 * also covers Grep, Glob, and the Edit tool on the same path, so the pair is
 * belt and braces across Claude Code versions rather than two separate fences.
 *
 * A path containing a comma is skipped: the rules travel as one comma-separated
 * `--disallowedTools` value, so such a rule would arrive split in half and could
 * deny something else entirely. Losing a best-effort fence beats that.
 */
export function isolationDenyRules(projectRoot: string): readonly string[] {
  const path = resolve(projectRoot).replaceAll("\\", "/").replace(/\/+$/u, "");
  if (path.length === 0 || path.includes(",")) return [];
  return [`Read(//${path}/**)`, `Edit(//${path}/**)`];
}

/** The scaffolded setup command for this platform, relative to the project root. */
export function setupCommandPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ".aboard/session-setup.ps1" : ".aboard/session-setup.sh";
}

/**
 * Whether the setup file asks for anything. The scaffolded copies ship as
 * comments only, so "empty" — the default — must mean "run nothing" rather than
 * "run an empty script", which on PowerShell is a process spawn and an execution
 * policy away from being an error the user never asked for.
 */
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
    // `-File` rather than `-Command`: the script's own path is then a single
    // argument rather than text PowerShell parses, and `Bypass` is what lets an
    // unsigned local file run at all on a default Windows policy.
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
  readonly directories?: RunWorkspaceDirectories;
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

/**
 * Resolves a run's workspace: the user's own checkout when worktree mode is off,
 * a private one beside the project when it is on.
 *
 * Every step is idempotent, because a resumed run re-enters here with its
 * checkout already created, its dependencies already installed, and its session
 * branch already on it.
 */
export class WorktreeRunWorkspaces implements RunWorkspaceProvider {
  readonly #directories: RunWorkspaceDirectories;
  readonly #platform: NodeJS.Platform;
  readonly #setup: SetupCommandRunner;
  readonly #readSetupFile: (path: string) => Promise<string | undefined>;

  public constructor(private readonly options: WorktreeRunWorkspaceOptions) {
    this.#directories = options.directories ?? nodeDirectories;
    this.#platform = options.platform ?? process.platform;
    this.#setup = options.setup ?? processSetupCommandRunner;
    this.#readSetupFile = options.readSetupFile
      ?? (async (path) => { try { return await readFile(path, "utf8"); } catch { return undefined; } });
  }

  public isolates(): boolean {
    return this.options.settings().enabled;
  }

  public async prepare(request: RunWorkspaceRequest): Promise<RunWorkspace> {
    const settings = this.options.settings();
    if (!settings.enabled) {
      return { root: this.options.workspaceRoot, git: this.options.git, denyTools: [], isolated: false };
    }
    await this.#requireTrackedAssets();
    const path = runWorkspacePath({
      workspaceRoot: this.options.workspaceRoot,
      runId: request.runId,
      root: settings.root,
    });
    const created = await this.#checkout(path, request);
    // The gitignored runtime directory does not come with a checkout, and every
    // launch writes its rewritten agent definition and any spilled prompt under
    // it — as paths relative to the session's own directory.
    await this.#directories.create(join(path, ".aboard", "runtime", "agents"));
    await this.#directories.create(join(path, ".aboard", "runtime", "prompts"));
    if (created) await this.#runSetup(path, request);
    await this.#requireCleanCheckout(path, created);
    this.options.notify(autoRunMessage.workspace(path));
    return {
      root: path,
      git: this.options.gitFor(path),
      denyTools: isolationDenyRules(this.options.workspaceRoot),
      isolated: true,
    };
  }

  public async release(workspace: RunWorkspace, outcome: RunWorkspaceOutcome): Promise<KeptRunWorkspace | undefined> {
    if (!workspace.isolated) return undefined;
    const settings = this.options.settings();
    if (settings.keep) return { path: workspace.root, reason: "kept-by-setting" };
    // An interrupted run leaves terminals open in there and work the user is
    // being asked to look at. Removing it would delete exactly what they were
    // told to go and see.
    if (outcome === "interrupted") return { path: workspace.root, reason: "left-for-the-user" };
    try {
      await this.options.git.removeWorktree(workspace.root, true);
    } catch (error) {
      // Routine on Windows, where a shell whose current directory is inside the
      // checkout holds it open for as long as it takes to notice it was killed.
      this.options.log?.(`auto-run could not remove its checkout at ${workspace.root}: ${describe(error)}`);
      return { path: workspace.root, reason: "removal-failed" };
    }
    // `git worktree remove` takes the checkout, not the per-run directory that
    // held it.
    await this.#directories.remove(dirname(workspace.root)).catch(() => undefined);
    return undefined;
  }

  /**
   * A second checkout contains what is committed. aboard's hook registration is
   * the load-bearing part: without it a worker starts, does its work, and reports
   * nothing, which the run can only observe as a launch that never came up.
   */
  async #requireTrackedAssets(): Promise<void> {
    const tracked = new Set(await this.options.git.trackedPaths(REQUIRED_TRACKED_PATHS));
    const missing = REQUIRED_TRACKED_PATHS.filter((path) => !tracked.has(path));
    if (missing.length === 0) return;
    throw new RunWorkspaceError(
      `a run with its own checkout needs aboard's hooks committed, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not tracked by git. Commit ${missing.length === 1 ? "it" : "them"}, or turn aboard.autoRun.worktree.enabled off`,
    );
  }

  /** Creates the checkout, or re-attaches to the one a previous attempt made. */
  async #checkout(path: string, request: RunWorkspaceRequest): Promise<boolean> {
    const existing = (await this.options.git.worktrees()).find((worktree) => samePath(worktree.path, path));
    if (existing !== undefined) return false;
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
    // Cut from the remote's copy of the base for the same reason the in-place
    // run does: a run must not inherit local commits the user has not published.
    const startPoint = await this.options.git.remoteBranchExists(request.base)
      ? `origin/${request.base}`
      : request.base;
    await this.options.git.addWorktree(path, request.sessionBranch, startPoint);
    return true;
  }

  /**
   * Runs the project's own setup file, which is where a checkout that needs an
   * `.env`, a virtualenv, or an install becomes usable. A failure refuses the
   * run: half-installed dependencies surface three phases later as an
   * implementer that cannot explain itself.
   */
  async #runSetup(path: string, request: RunWorkspaceRequest): Promise<void> {
    const relativePath = setupCommandPath(this.#platform);
    // The project root's copy, not the checkout's: the user edits the former,
    // while the latter is whatever the session branch happens to carry.
    const script = join(this.options.workspaceRoot, ...relativePath.split("/"));
    const source = await this.#readSetupFile(script);
    if (source === undefined || !hasSetupCommands(source)) return;
    const { command, args } = setupCommandLine(script, this.#platform);
    this.options.notify(autoRunMessage.setup(relativePath));
    const timeoutMs = Math.max(1, this.options.settings().setupTimeoutSeconds) * 1_000;
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

  /**
   * The run stages with `git add -A`, so anything the setup file left untracked
   * and ungitignored would land in the first issue's commit and its pull request.
   * That is the user's `.env` in a branch, so it refuses rather than warns.
   */
  async #requireCleanCheckout(path: string, created: boolean): Promise<void> {
    // Only a checkout this attempt created has to be clean. A resumed run's may
    // legitimately hold an implementer's uncommitted work.
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
