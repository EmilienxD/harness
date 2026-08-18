/**
 * The git boundary (`AGENTS.md`).
 *
 * Every git side effect in the auto-run loop is performed by the extension, so
 * git needs a real seam rather than the ad-hoc `execFile("git", …)` calls it
 * replaces. The interface is what the engine and the hook paths actually need;
 * a fake implementing it is enough to test the whole loop without a repository.
 */

import { execFile } from "node:child_process";
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

/**
 * What the repository contains, for the question every recommendation rests on
 * and that no other briefing section answers: is there a project here yet?
 *
 * A repository with no source file cannot be surveyed, so a roadmap, an
 * estimate, or a "what's left" answer derived from it is invention. The Manager
 * would otherwise pay a turn to find that out — and the cheap version of that
 * turn (`ls`) is also the wrong one, because a README and a licence look like
 * content while carrying no intent. Counting *source* files is what separates
 * the two, which is why documentation, configuration, and data extensions are
 * deliberately not in the set below.
 */
export interface CodebaseSurvey {
  /** Source files present, tracked or not, excluding anything gitignored. */
  readonly sourceFileCount: number;
  /** The extensions carrying that count, most files first, at most five. */
  readonly languages: readonly string[];
  /** Commits reachable from HEAD. `0` on an unborn branch. */
  readonly commitCount: number;
}

/**
 * Extensions that count as code. The list decides one thing — whether this
 * repository can be surveyed at all — so it errs towards inclusion for anything
 * a project is written *in*, and excludes everything a project is described in
 * (`.md`), configured by (`.json`, `.yml`, `.toml`), or ships as data. A
 * README-only repository must read as "no code yet", because that is exactly
 * what it is.
 */
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
  fetch(): Promise<void>;
  checkout(branch: string): Promise<void>;
  createBranch(branch: string, from: string): Promise<void>;
  /** Fast-forwards `branch`, which must be checked out, to its upstream. */
  fastForward(branch: string): Promise<void>;
  add(): Promise<void>;
  commit(subject: string, body: string): Promise<string>;
  push(branch: string, setUpstream: boolean): Promise<void>;
  /** Whether HEAD carries a commit whose message references this issue. */
  hasCommitFor(issueNumber: number, base: string): Promise<boolean>;
  /**
   * Whether the local branch and its remote tracking ref point at the same
   * commit. The `commit` phase's postcondition is "committed **and** pushed", and
   * those are two effects that can fail independently: a push that fails after a
   * successful commit must resume by retrying the push, not by trying to open a
   * pull request for a branch the remote has never seen.
   */
  isPushed(branch: string): Promise<boolean>;
}

export class ProcessGitClient implements GitClient {
  public constructor(private readonly cwd: string) {}

  public async currentBranch(): Promise<string | undefined> {
    const branch = await this.run(["branch", "--show-current"]);
    return branch.length === 0 ? undefined : branch;
  }

  public async defaultBranch(): Promise<string> {
    // `origin/HEAD` is the authoritative answer but is only present when the
    // clone recorded it; refreshing it costs a network round trip, so fall back
    // to the conventional names before failing.
    const symbolic = await this.tryRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (symbolic !== undefined && symbolic.startsWith("origin/")) return symbolic.slice("origin/".length);
    for (const candidate of ["main", "master"]) {
      if (await this.branchExists(candidate)) return candidate;
    }
    throw new GitBoundaryError("no-default-branch", "Unable to resolve the repository's default branch");
  }

  public async status(): Promise<GitStatus> {
    const output = await this.run(["status", "--porcelain"]);
    const entries = output.split(/\r?\n/u).flatMap((line) => {
      if (line.trim().length === 0) return [];
      return [{ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }];
    });
    return { branch: await this.currentBranch(), entries };
  }

  /**
   * One `ls-files` and one `rev-list`. `--cached --others --exclude-standard`
   * is the right file set for this question: it sees work the user has not
   * committed yet — a fresh project's normal state — while `--exclude-standard`
   * drops everything `.gitignore` covers, so a `node_modules` or a build
   * directory cannot make an empty repository look like a codebase. Both calls
   * are probes: an unborn branch has no HEAD to count, and neither absence is a
   * failure worth degrading the section for.
   */
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

  public async fetch(): Promise<void> {
    await this.run(["fetch", "origin", "--prune"]);
  }

  public async checkout(branch: string): Promise<void> {
    await this.run(["checkout", branch]);
  }

  public async createBranch(branch: string, from: string): Promise<void> {
    await this.run(["checkout", "-b", branch, from]);
  }

  public async fastForward(branch: string): Promise<void> {
    await this.run(["merge", "--ff-only", `origin/${branch}`]);
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
    // Only commits this branch adds over its base count. A commit reachable from
    // the base mentioning the same issue is somebody else's work, not this run's
    // postcondition.
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

  /** For probes where a non-zero exit is an answer rather than a failure. */
  private async tryRun(args: readonly string[]): Promise<string | undefined> {
    try {
      return await this.run(args);
    } catch {
      return undefined;
    }
  }
}

export function isWorkingTreeClean(status: GitStatus): boolean {
  return status.entries.length === 0;
}

export function dirtyPaths(status: GitStatus): readonly string[] {
  return status.entries.map((entry) => entry.path);
}
