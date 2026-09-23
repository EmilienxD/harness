import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { RUN_OWNED_BRANCH_PREFIXES } from "../domain/auto-run.js";
import type { GitHubClient } from "../github/client.js";

const execFileAsync = promisify(execFile);

export interface AboardPullRequest {
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly head: string;
  readonly base: string;
  readonly title: string;
}

export interface AboardBranchDiscovery {
  readonly defaultBranch: string;
  readonly branches: readonly AboardBranch[];
  readonly pullRequests: readonly AboardPullRequest[];
}

export interface AboardBranch {
  readonly name: string;
  readonly localSha?: string;
  readonly remoteSha?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly checkout?: { readonly path: string; readonly dirtyPaths: readonly string[]; readonly primary: boolean };
}

export interface AboardBranchClearResult {
  readonly deletedLocal: readonly string[];
  readonly deletedRemote: readonly string[];
  readonly retained: readonly string[];
}

export interface AboardBranchRepository {
  discover(): Promise<Omit<AboardBranchDiscovery, "pullRequests">>;
  checkoutDefault(expectedBranch: string, defaultBranch: string): Promise<boolean>;
  deleteLocal(branch: string, expectedSha: string): Promise<boolean>;
  deleteRemote(branch: string, expectedSha: string): Promise<boolean>;
}

/** Two-phase cleanup: execution accepts and guards the exact read-only snapshot shown to the user. */
export class AboardBranchCleanup {
  public constructor(private readonly git: AboardBranchRepository, private readonly github: Pick<GitHubClient, "listPullRequestsForBranches">) {}

  public async discover(): Promise<AboardBranchDiscovery> {
    const found = await this.git.discover();
    return { ...found, pullRequests: await this.github.listPullRequestsForBranches(found.branches.map((branch) => branch.name)) };
  }

  public async clear(snapshot: AboardBranchDiscovery): Promise<AboardBranchClearResult> {
    const deletedLocal: string[] = [];
    const deletedRemote: string[] = [];
    const retained: string[] = [];
    for (const branch of snapshot.branches) {
      if (branch.remoteSha !== undefined) {
        if (await this.git.deleteRemote(branch.name, branch.remoteSha)) deletedRemote.push(branch.name);
        else retained.push(`origin/${branch.name} changed after discovery`);
      }
      if (branch.localSha === undefined) continue;
      if (branch.checkout !== undefined) {
        if (!branch.checkout.primary) { retained.push(`${branch.name} is checked out at ${branch.checkout.path}`); continue; }
        if (branch.checkout.dirtyPaths.length > 0) { retained.push(`${branch.name} has uncommitted work: ${branch.checkout.dirtyPaths.join(", ")}`); continue; }
        if (!await this.git.checkoutDefault(branch.name, snapshot.defaultBranch)) { retained.push(`${branch.name} could not be left safely`); continue; }
      }
      if (await this.git.deleteLocal(branch.name, branch.localSha)) deletedLocal.push(branch.name);
      else retained.push(`${branch.name} changed after discovery`);
    }
    return { deletedLocal, deletedRemote, retained };
  }
}

export class ProcessAboardBranchRepository implements AboardBranchRepository {
  public constructor(private readonly cwd: string) {}

  public async discover(): Promise<Omit<AboardBranchDiscovery, "pullRequests">> {
    const defaultBranch = await this.defaultBranch();
    const refs = await this.run(["for-each-ref", "--format=%(refname)%09%(objectname)", ...RUN_OWNED_BRANCH_PREFIXES.map((prefix) => `refs/heads/${prefix}`)]);
    const remoteRefs = await this.run(["ls-remote", "--heads", "origin", ...RUN_OWNED_BRANCH_PREFIXES.map((prefix) => `refs/heads/${prefix}*`)]);
    const byName = new Map<string, { localSha?: string; remoteSha?: string }>();
    for (const line of refs.split(/\r?\n/u).filter(Boolean)) {
      const [ref, sha] = line.split("\t");
      if (ref === undefined || sha === undefined) continue;
      const name = ref.replace("refs/heads/", "");
      if (!RUN_OWNED_BRANCH_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      byName.set(name, { ...byName.get(name), localSha: sha });
    }
    for (const line of remoteRefs.split(/\r?\n/u).filter(Boolean)) {
      const [sha, ref] = line.split("\t");
      if (ref === undefined || sha === undefined) continue;
      const name = ref.replace("refs/heads/", "");
      if (!RUN_OWNED_BRANCH_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      byName.set(name, { ...byName.get(name), remoteSha: sha });
    }
    const worktrees = await this.worktrees();
    const branches: AboardBranch[] = [];
    for (const [name, locations] of [...byName].sort(([left], [right]) => left.localeCompare(right))) {
      const ref = locations.localSha === undefined ? locations.remoteSha! : name;
      const counts = (await this.tryRun(["rev-list", "--left-right", "--count", `${defaultBranch}...${ref}`]))?.split(/\s+/u).map(Number) ?? [0, 0];
      const checkout = worktrees.find((entry) => entry.branch === name);
      branches.push({ name, ...locations, behind: counts[0] ?? 0, ahead: counts[1] ?? 0, ...(checkout === undefined ? {} : { checkout }) });
    }
    return { defaultBranch, branches };
  }

  public async checkoutDefault(expectedBranch: string, defaultBranch: string): Promise<boolean> {
    if ((await this.tryRun(["branch", "--show-current"])) !== expectedBranch) return false;
    return (await this.tryRun(["checkout", defaultBranch])) !== undefined;
  }

  public async deleteLocal(branch: string, expectedSha: string): Promise<boolean> {
    if ((await this.tryRun(["rev-parse", `refs/heads/${branch}`])) !== expectedSha) return false;
    return (await this.tryRun(["branch", "-D", branch])) !== undefined;
  }

  public async deleteRemote(branch: string, expectedSha: string): Promise<boolean> {
    const observed = (await this.tryRun(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]))?.split(/\s+/u)[0];
    if (observed !== expectedSha) return false;
    return (await this.tryRun(["push", `--force-with-lease=${branch}:${expectedSha}`, "origin", `:${branch}`])) !== undefined;
  }

  private async worktrees(): Promise<readonly { branch: string; path: string; dirtyPaths: readonly string[]; primary: boolean }[]> {
    const output = await this.run(["worktree", "list", "--porcelain"]);
    const rows: { path: string; branch?: string }[] = [];
    let row: { path: string; branch?: string } | undefined;
    for (const line of output.split(/\r?\n/u)) {
      if (line.startsWith("worktree ")) { if (row !== undefined) rows.push(row); row = { path: line.slice(9) }; }
      else if (line.startsWith("branch ") && row !== undefined) row.branch = line.slice(7).replace(/^refs\/heads\//u, "");
    }
    if (row !== undefined) rows.push(row);
    return Promise.all(rows.flatMap((entry) => entry.branch === undefined ? [] : [this.statusAt(entry.path, entry.branch)]));
  }

  private async statusAt(path: string, branch: string) {
    const { stdout } = await execFileAsync("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: path, encoding: "utf8", windowsHide: true });
    return { branch, path, dirtyPaths: stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).trim()), primary: resolve(path) === resolve(this.cwd) };
  }

  private async defaultBranch(): Promise<string> {
    const symbolic = await this.tryRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (symbolic?.startsWith("origin/")) return symbolic.slice(7);
    for (const candidate of ["main", "master"]) if (await this.tryRun(["rev-parse", `refs/heads/${candidate}`]) !== undefined) return candidate;
    throw new Error("Unable to resolve the repository's default branch");
  }

  private async run(args: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", [...args], { cwd: this.cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }
  private async tryRun(args: readonly string[]): Promise<string | undefined> { try { return await this.run(args); } catch { return undefined; } }
}

export function describeAboardBranchDiscovery(snapshot: AboardBranchDiscovery): string {
  if (snapshot.branches.length === 0) return "No local or GitHub issue/* or abd/* branches were found.";
  const lines = snapshot.branches.map((branch) => {
    const location = branch.localSha !== undefined && branch.remoteSha !== undefined ? (branch.localSha === branch.remoteSha ? "local + GitHub, in sync" : "local + GitHub, diverged") : branch.localSha !== undefined ? "local only" : "GitHub only";
    const checkout = branch.checkout === undefined ? "" : branch.checkout.dirtyPaths.length > 0 ? `; checked out with ${branch.checkout.dirtyPaths.length} uncommitted path(s): ${branch.checkout.dirtyPaths.join(", ")}` : `; checked out at ${branch.checkout.path} (clean)`;
    const prs = snapshot.pullRequests.filter((pr) => pr.head === branch.name || pr.base === branch.name).map((pr) => `#${pr.number} ${pr.state} “${pr.title}” (${pr.head} → ${pr.base})`).join(", ");
    return `${branch.name}\n  ${location}; ${branch.ahead} ahead / ${branch.behind} behind ${snapshot.defaultBranch}${checkout}${prs.length === 0 ? "; no pull request" : `; PR ${prs}`}`;
  });
  return `The following branches will be removed where safe. Open pull requests can be closed by deleting their GitHub head or base branch. Dirty worktrees are retained. Every deletion is SHA-guarded against changes after this discovery.\n\n${lines.join("\n\n")}`;
}
