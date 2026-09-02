
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitErrorCode = "command-failed" | "not-a-repository" | "detached-head" | "no-default-branch";

export class GitBoundaryError extends Error {
  public constructor(
    public readonly code: GitErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GitBoundaryError";
  }
}

/** One porcelain entry: the two-character status code and the path it applies to. */
export interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
}

export interface GitStatus {
  readonly branch: string | undefined;
  readonly entries: readonly GitStatusEntry[];
}

export interface GitWorktree {
  readonly path: string;
  readonly branch: string | undefined;
}

export interface CodebaseSurvey {
  /** Source files present, tracked or not, excluding anything gitignored. */
  readonly sourceFileCount: number;
  /** The extensions carrying that count, most files first, at most five. */
  readonly languages: readonly string[];
  /** Commits reachable from HEAD. `0` on an unborn branch. */
  readonly commitCount: number;
}

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro",
  "py", "rb", "go", "rs", "java", "kt", "kts", "scala", "clj", "cljs", "groovy",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "swift", "cs", "fs", "vb",
  "php", "pl", "pm", "lua", "dart", "ex", "exs", "erl", "hs", "ml", "mli", "nim",
  "zig", "jl", "r", "sql", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
  "sol", "tf", "gradle", "sbt", "asm", "s", "elm", "purs", "res", "rescript", "odin",
]);

function extensionOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

/** Split out so the classification can be tested without a repository. */
export function summarizeSourceFiles(paths: readonly string[]): Omit<CodebaseSurvey, "commitCount"> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const extension = extensionOf(path);
    if (extension === undefined || !SOURCE_EXTENSIONS.has(extension)) continue;
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  const languages = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([extension]) => extension);
  let sourceFileCount = 0;
  for (const count of counts.values()) sourceFileCount += count;
  return { sourceFileCount, languages };
}

export interface CommitDetails {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly message: string;
  readonly treeSha: string;
}

export interface GitClient {
  /** Current branch name, or `undefined` on a detached HEAD. */
  currentBranch(): Promise<string | undefined>;
  /** The remote's default branch (`origin/HEAD`), falling back to a local guess. */
  defaultBranch(): Promise<string>;
  status(): Promise<GitStatus>;
  /** What the repository contains: source files by language, and its commit count. */
  codebase(): Promise<CodebaseSurvey>;
  headSha(short?: boolean): Promise<string>;
  branchExists(branch: string): Promise<boolean>;
  /** Which of these branches exist, locally and on the remote, in one read. */
  existingBranches(branches: readonly string[]): Promise<{ readonly local: ReadonlySet<string>; readonly remote: ReadonlySet<string> }>;
  branchSha(branch: string): Promise<string | undefined>;
  /** The same, for `origin/<branch>` as of the last fetch. */
  remoteBranchSha(branch: string): Promise<string | undefined>;
  /** Commits reachable from each ref but not the other. */
  aheadBehind(left: string, right: string): Promise<{ readonly ahead: number; readonly behind: number }>;
  /** Whether `ancestor` is reachable from `descendant`. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  commitDetails(ref: string): Promise<CommitDetails | undefined>;
  /** The tree represented by the current index, used before creating a commit. */
  stagedTreeSha(): Promise<string>;
  deleteBranchAt(branch: string, expectedSha: string): Promise<boolean>;
  /** The same guard against `origin/<branch>`, then a delete-push. */
  deleteRemoteBranchAt(branch: string, expectedSha: string): Promise<boolean>;
  remoteBranchExists(branch: string): Promise<boolean>;
  /**
   * Updates remote-tracking refs. `fresh` bypasses any fetch coalescing the
   * client applies, for the reads that verify a mutation's recorded outcome.
   */
  fetch(options?: { readonly fresh?: boolean }): Promise<void>;
  checkout(branch: string): Promise<void>;
  createBranch(branch: string, from: string): Promise<void>;
  /** Deletes a local branch only when Git considers it fully merged. */
  deleteBranch(branch: string): Promise<void>;
  /** Fast-forwards `branch`, which must be checked out, to its upstream. */
  fastForward(branch: string): Promise<void>;
  mergeFromRemote(base: string): Promise<boolean>;
  add(): Promise<void>;
  commit(subject: string, body: string): Promise<string>;
  push(branch: string, setUpstream: boolean): Promise<void>;
  /** Whether HEAD carries a commit whose message references this issue. */
  hasCommitFor(issueNumber: number, base: string): Promise<boolean>;
  isPushed(branch: string): Promise<boolean>;
  /** Which repository-relative paths are excluded by the checkout's ignore rules. */
  ignoredPaths(paths: readonly string[]): Promise<readonly string[]>;
  /** Tracked entries at `ref` beneath a repository-relative directory. */
  trackedPathsUnder(ref: string, directory: string): Promise<readonly string[]>;
  worktrees(): Promise<readonly GitWorktree[]>;
  addWorktree(path: string, branch: string, startPoint?: string): Promise<void>;
  removeWorktree(path: string, force: boolean): Promise<void>;
}

export class ProcessGitClient implements GitClient {
  public constructor(private readonly cwd: string) {}

  public async currentBranch(): Promise<string | undefined> {
    const branch = await this.run(["branch", "--show-current"]);
    return branch.length === 0 ? undefined : branch;
  }

  public async defaultBranch(): Promise<string> {
    const symbolic = await this.tryRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (symbolic !== undefined && symbolic.startsWith("origin/")) return symbolic.slice("origin/".length);
    for (const candidate of ["main", "master"]) {
      if (await this.branchExists(candidate)) return candidate;
    }
    throw new GitBoundaryError("no-default-branch", "Unable to resolve the repository's default branch");
  }

  public async status(): Promise<GitStatus> {
    // Admission must see untracked/submodule changes even when personal Git
    // display settings normally hide them.
    // Background observations must not refresh the index and contend with checkout.
    const output = await this.run(["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
    const entries = output.split(/\r?\n/u).flatMap((line) => {
      if (line.trim().length === 0) return [];
      return [{ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }];
    });
    return { branch: await this.currentBranch(), entries };
  }

  public async codebase(): Promise<CodebaseSurvey> {
    const listed = await this.tryRun(["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "";
    const paths = listed.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    const commits = Number.parseInt(await this.tryRun(["rev-list", "--count", "HEAD"]) ?? "0", 10);
    return {
      ...summarizeSourceFiles(paths),
      commitCount: Number.isFinite(commits) ? commits : 0,
    };
  }

  public async headSha(short = true): Promise<string> {
    return this.run(short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"]);
  }

  public async branchExists(branch: string): Promise<boolean> {
    return await this.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined;
  }

  public async existingBranches(branches: readonly string[]): Promise<{ readonly local: ReadonlySet<string>; readonly remote: ReadonlySet<string> }> {
    const wanted = new Set(branches);
    const local = new Set<string>();
    const remote = new Set<string>();
    if (wanted.size === 0) return { local, remote };
    // One ref listing instead of two probes per branch. for-each-ref matches
    // whole ref namespaces, so the branch names still need the exact filter.
    const listed = await this.tryRun(["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/origin/"]);
    for (const ref of (listed ?? "").split(/\r?\n/u)) {
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice("refs/heads/".length);
        if (wanted.has(name)) local.add(name);
      } else if (ref.startsWith("refs/remotes/origin/")) {
        const name = ref.slice("refs/remotes/origin/".length);
        if (wanted.has(name)) remote.add(name);
      }
    }
    return { local, remote };
  }

  public async branchSha(branch: string): Promise<string | undefined> {
    return this.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  }

  public async remoteBranchSha(branch: string): Promise<string | undefined> {
    return this.tryRun(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  }

  public async aheadBehind(left: string, right: string): Promise<{ readonly ahead: number; readonly behind: number }> {
    const output = await this.run(["rev-list", "--left-right", "--count", `${left}...${right}`]);
    const [ahead, behind] = output.split(/\s+/u).map(Number);
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind) || ahead! < 0 || behind! < 0) {
      throw new GitBoundaryError("command-failed", `git returned invalid ahead/behind counts for ${left} and ${right}`);
    }
    return { ahead: ahead!, behind: behind! };
  }

  public async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.run(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (error instanceof GitBoundaryError && typeof error.details === "object" && error.details !== null
        && "exitCode" in error.details && error.details.exitCode === 1) return false;
      throw error;
    }
  }

  public async commitDetails(ref: string): Promise<CommitDetails | undefined> {
    // One field per line, subject last: a commit subject can contain any
    // printable character but never a newline, so nothing needs escaping.
    const output = await this.tryRun(["show", "--no-patch", "--format=%H%n%P%n%T%n%B", ref]);
    if (output === undefined) return undefined;
    const [sha, parents, treeSha, ...messageLines] = output.split(/\r?\n/u);
    if (sha === undefined || sha.length === 0) return undefined;
    const message = messageLines.join("\n").trim();
    return {
      sha,
      parents: (parents ?? "").split(" ").filter((entry) => entry.length > 0),
      subject: messageLines[0] ?? "",
      message,
      treeSha: treeSha ?? "",
    };
  }

  public async stagedTreeSha(): Promise<string> {
    return this.run(["write-tree"]);
  }

  public async deleteBranchAt(branch: string, expectedSha: string): Promise<boolean> {
    if (await this.branchSha(branch) !== expectedSha) return false;
    return await this.tryRun(["branch", "-D", branch]) !== undefined;
  }

  public async deleteRemoteBranchAt(branch: string, expectedSha: string): Promise<boolean> {
    if (await this.remoteBranchSha(branch) !== expectedSha) return false;
    return await this.tryRun(["push", "--delete", `--force-with-lease=${branch}:${expectedSha}`, "origin", branch]) !== undefined;
  }

  public async remoteBranchExists(branch: string): Promise<boolean> {
    return await this.tryRun(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]) !== undefined;
  }

  public async fetch(): Promise<void> {
    await this.run(["fetch", "origin", "--prune"]);
  }

  public async checkout(branch: string): Promise<void> {
    await this.runCheckout(["checkout", branch]);
  }

  public async createBranch(branch: string, from: string): Promise<void> {
    await this.runCheckout(["checkout", "-b", branch, from]);
  }

  public async deleteBranch(branch: string): Promise<void> {
    // Deliberately not `-D`: cleanup must never discard a commit merely because
    // an implementer unexpectedly left the working tree clean.
    await this.run(["branch", "-d", branch]);
  }

  public async fastForward(branch: string): Promise<void> {
    await this.run(["merge", "--ff-only", `origin/${branch}`]);
  }

  public async mergeFromRemote(base: string): Promise<boolean> {
    try {
      await this.run(["merge", "--no-edit", `origin/${base}`]);
      return true;
    } catch {
      await this.tryRun(["merge", "--abort"]);
      return false;
    }
  }

  public async add(): Promise<void> {
    await this.run(["add", "-A"]);
  }

  public async commit(subject: string, body: string): Promise<string> {
    // `-m` twice rather than one embedded newline: the message is user-visible
    // and git's own subject/body split is what every log format expects.
    await this.run(["commit", "-m", subject, "-m", body]);
    return this.headSha();
  }

  public async push(branch: string, setUpstream: boolean): Promise<void> {
    await this.run(setUpstream ? ["push", "-u", "origin", branch] : ["push", "origin", branch]);
  }

  public async hasCommitFor(issueNumber: number, base: string): Promise<boolean> {
    const log = await this.tryRun(["log", `${base}..HEAD`, "--format=%B"]);
    if (log === undefined || log.length === 0) return false;
    return new RegExp(`(?:^|\\s)#${issueNumber}(?![0-9])`, "u").test(log);
  }

  public async isPushed(branch: string): Promise<boolean> {
    const local = await this.tryRun(["rev-parse", `refs/heads/${branch}`]);
    if (local === undefined) return false;
    const remote = await this.tryRun(["rev-parse", `refs/remotes/origin/${branch}`]);
    return remote !== undefined && remote === local;
  }

  public async ignoredPaths(paths: readonly string[]): Promise<readonly string[]> {
    const ignored = new Set<string>();
    if (paths.length === 0) return [];
    // NUL-delimited stdin handles arbitrary filenames and avoids Windows'
    // command-line limit when a `.claude` tree contains many support files.
    const listed = await this.tryRunWithInput(
      ["check-ignore", "--no-index", "--stdin", "-z"],
      `${paths.join("\0")}\0`,
    );
    if (listed !== undefined) {
      for (const path of listed.split("\0")) {
        if (path.length > 0) ignored.add(path.replaceAll("\\", "/"));
      }
    }
    return paths.filter((path) => ignored.has(path.replaceAll("\\", "/")));
  }

  public async trackedPathsUnder(ref: string, directory: string): Promise<readonly string[]> {
    const listed = await this.run(["ls-tree", "-r", "--name-only", "-z", ref, "--", directory]);
    return listed.split("\0").filter((path) => path.length > 0);
  }

  public async worktrees(): Promise<readonly GitWorktree[]> {
    const output = await this.tryRun(["worktree", "list", "--porcelain"]);
    if (output === undefined) return [];
    const worktrees: GitWorktree[] = [];
    let path: string | undefined;
    let branch: string | undefined;
    const flush = (): void => {
      if (path !== undefined) worktrees.push({ path, branch });
      path = undefined;
      branch = undefined;
    };
    for (const line of output.split(/\r?\n/u)) {
      if (line.startsWith("worktree ")) { flush(); path = line.slice("worktree ".length).trim(); }
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//u, "");
    }
    flush();
    return worktrees;
  }

  public async addWorktree(path: string, branch: string, startPoint?: string): Promise<void> {
    await this.run(
      startPoint === undefined
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "-b", branch, path, startPoint],
    );
  }

  public async removeWorktree(path: string, force: boolean): Promise<void> {
    await this.run(force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path]);
  }

  private async runCheckout(args: readonly string[]): Promise<void> {
    const waits = [100, 200, 400, 800, 1_600];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.run(args);
        return;
      } catch (error) {
        const details = error instanceof GitBoundaryError ? error.details : undefined;
        const wait = waits[attempt];
        // This failure occurs before checkout changes the tree or creates a
        // branch. Retry only that refusal, never a partial checkout or hook
        // failure, and leave the other process's lock alone.
        if (wait === undefined || typeof details !== "object" || details === null
          || !("exitCode" in details) || details.exitCode !== 128
          || !("stderr" in details) || typeof details.stderr !== "string"
          || !/^fatal: Unable to create '[^\r\n]*[/\\]index\.lock': File exists\.(?:\r?\n|$)/u.test(details.stderr)) throw error;
        await delay(wait);
      }
    }
  }

  private async run(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", [...args], {
        cwd: this.cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      const cause = error as { code?: unknown; stderr?: unknown };
      throw new GitBoundaryError("command-failed", `git ${args[0] ?? ""} failed`, {
        exitCode: typeof cause.code === "number" ? cause.code : undefined,
        stderr: typeof cause.stderr === "string" ? cause.stderr.trim().slice(0, 2_000) : undefined,
      });
    }
  }

  private async runWithInput(args: readonly string[], input: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        "git",
        [...args],
        {
          cwd: this.cwd,
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error === null) return resolvePromise(stdout);
          const cause = error as { code?: unknown };
          reject(new GitBoundaryError("command-failed", `git ${args[0] ?? ""} failed`, {
            exitCode: typeof cause.code === "number" ? cause.code : undefined,
            stderr: stderr.trim().slice(0, 2_000),
          }));
        },
      );
      child.stdin?.end(input);
    });
  }

  /** For probes where a non-zero exit is an answer rather than a failure. */
  private async tryRun(args: readonly string[]): Promise<string | undefined> {
    try {
      return await this.run(args);
    } catch {
      return undefined;
    }
  }

  private async tryRunWithInput(args: readonly string[], input: string): Promise<string | undefined> {
    try {
      return await this.runWithInput(args, input);
    } catch {
      return undefined;
    }
  }
}

export const FETCH_FRESHNESS_MS = 5_000;

/**
 * Coalesces remote fetches. Every fetch updates the same remote-tracking refs,
 * so one that succeeded moments ago already serves the next reader; the reads
 * that verify a mutation's postcondition ask for `fresh` instead. Callers are
 * not serialized: a fetch in flight is shared rather than queued behind.
 */
export class CachingGitClient implements GitClient {
  #fetchedAt = -Infinity;
  #inFlight: Promise<void> | undefined;

  public constructor(
    private readonly inner: GitClient,
    private readonly freshnessMs: number = FETCH_FRESHNESS_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async fetch(options?: { readonly fresh?: boolean }): Promise<void> {
    if (options?.fresh === true) {
      this.#inFlight = undefined;
      await this.inner.fetch();
      this.#fetchedAt = this.now();
      return;
    }
    if (this.#inFlight !== undefined) return this.#inFlight;
    if (this.now() - this.#fetchedAt < this.freshnessMs) return;
    const pending = this.inner.fetch().then(() => {
      this.#fetchedAt = this.now();
    }).finally(() => {
      // A failed fetch records nothing, so the next caller retries remotely.
      if (this.#inFlight === pending) this.#inFlight = undefined;
    });
    this.#inFlight = pending;
    return pending;
  }

  public currentBranch(): ReturnType<GitClient["currentBranch"]> { return this.inner.currentBranch(); }
  public defaultBranch(): ReturnType<GitClient["defaultBranch"]> { return this.inner.defaultBranch(); }
  public status(): ReturnType<GitClient["status"]> { return this.inner.status(); }
  public codebase(): ReturnType<GitClient["codebase"]> { return this.inner.codebase(); }
  public headSha(short?: boolean): ReturnType<GitClient["headSha"]> { return this.inner.headSha(short); }
  public branchExists(branch: string): ReturnType<GitClient["branchExists"]> { return this.inner.branchExists(branch); }
  public existingBranches(branches: readonly string[]): ReturnType<GitClient["existingBranches"]> { return this.inner.existingBranches(branches); }
  public branchSha(branch: string): ReturnType<GitClient["branchSha"]> { return this.inner.branchSha(branch); }
  public remoteBranchSha(branch: string): ReturnType<GitClient["remoteBranchSha"]> { return this.inner.remoteBranchSha(branch); }
  public aheadBehind(left: string, right: string): ReturnType<GitClient["aheadBehind"]> { return this.inner.aheadBehind(left, right); }
  public isAncestor(ancestor: string, descendant: string): ReturnType<GitClient["isAncestor"]> { return this.inner.isAncestor(ancestor, descendant); }
  public commitDetails(ref: string): ReturnType<GitClient["commitDetails"]> { return this.inner.commitDetails(ref); }
  public stagedTreeSha(): ReturnType<GitClient["stagedTreeSha"]> { return this.inner.stagedTreeSha(); }
  public deleteBranchAt(branch: string, expectedSha: string): ReturnType<GitClient["deleteBranchAt"]> { return this.inner.deleteBranchAt(branch, expectedSha); }
  public deleteRemoteBranchAt(branch: string, expectedSha: string): ReturnType<GitClient["deleteRemoteBranchAt"]> { return this.inner.deleteRemoteBranchAt(branch, expectedSha); }
  public remoteBranchExists(branch: string): ReturnType<GitClient["remoteBranchExists"]> { return this.inner.remoteBranchExists(branch); }
  public checkout(branch: string): ReturnType<GitClient["checkout"]> { return this.inner.checkout(branch); }
  public createBranch(branch: string, from: string): ReturnType<GitClient["createBranch"]> { return this.inner.createBranch(branch, from); }
  public deleteBranch(branch: string): ReturnType<GitClient["deleteBranch"]> { return this.inner.deleteBranch(branch); }
  public fastForward(branch: string): ReturnType<GitClient["fastForward"]> { return this.inner.fastForward(branch); }
  public mergeFromRemote(base: string): ReturnType<GitClient["mergeFromRemote"]> { return this.inner.mergeFromRemote(base); }
  public add(): ReturnType<GitClient["add"]> { return this.inner.add(); }
  public commit(subject: string, body: string): ReturnType<GitClient["commit"]> { return this.inner.commit(subject, body); }
  public push(branch: string, setUpstream: boolean): ReturnType<GitClient["push"]> { return this.inner.push(branch, setUpstream); }
  public hasCommitFor(issueNumber: number, base: string): ReturnType<GitClient["hasCommitFor"]> { return this.inner.hasCommitFor(issueNumber, base); }
  public isPushed(branch: string): ReturnType<GitClient["isPushed"]> { return this.inner.isPushed(branch); }
  public ignoredPaths(paths: readonly string[]): ReturnType<GitClient["ignoredPaths"]> { return this.inner.ignoredPaths(paths); }
  public trackedPathsUnder(ref: string, directory: string): ReturnType<GitClient["trackedPathsUnder"]> { return this.inner.trackedPathsUnder(ref, directory); }
  public worktrees(): ReturnType<GitClient["worktrees"]> { return this.inner.worktrees(); }
  public addWorktree(path: string, branch: string, startPoint?: string): ReturnType<GitClient["addWorktree"]> { return this.inner.addWorktree(path, branch, startPoint); }
  public removeWorktree(path: string, force: boolean): ReturnType<GitClient["removeWorktree"]> { return this.inner.removeWorktree(path, force); }
}

export function isWorkingTreeClean(status: GitStatus): boolean {
  return status.entries.length === 0;
}

export function dirtyPaths(status: GitStatus): readonly string[] {
  return status.entries.map((entry) => entry.path);
}
