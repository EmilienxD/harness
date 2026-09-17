import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { contains, DEFAULT_REPOSITORY, type HarnessConfig } from "./config.js";

const execFileAsync = promisify(execFile);
export const repositoryFixtureRoot = resolve(__dirname, "..", "..", "test", "e2e", "fixture", "repository");
const SEED_MESSAGE = "Seed deterministic E2E fixture";
const FIXED_DATE = "2026-01-01T00:00:00Z";
const REQUIRED_ACCOUNT = "EmilienxD";

const LABELS = [

  { name: "[AI]-afk", color: "0E8A16", description: "May run and merge unattended" },
  { name: "[AI]-hitl", color: "D93F0B", description: "Requires human review" },
  { name: "[AI]-chrome", color: "5319E7", description: "Enable Claude in Chrome for the address worker" },
  { name: "[AI]-routine-difficulty", color: "C2E0C6", description: "Routine implementation difficulty" },
  { name: "[AI]-basic-difficulty", color: "BFDADC", description: "Basic implementation difficulty" },
  { name: "[AI]-advanced-difficulty", color: "FBCA04", description: "Advanced implementation difficulty" },
  { name: "[AI]-expert-difficulty", color: "B60205", description: "Expert implementation difficulty" },
] as const;

interface OwnershipRecord {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly cloneRoot: string;
}

export async function bootstrap(config: HarnessConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (config.repository !== DEFAULT_REPOSITORY) throw new Error(`bootstrap target must be exactly ${DEFAULT_REPOSITORY}`);
  if (env.ABOARD_E2E_RECREATE !== config.repository) {
    throw new Error(`Set ABOARD_E2E_RECREATE=${config.repository} to confirm destructive repository recreation`);
  }
  const auth = parseAuth(await run("gh", ["auth", "status", "--active", "-h", "github.com", "--json", "hosts"]));
  if (auth.login !== REQUIRED_ACCOUNT) throw new Error(`Active GitHub account must be ${REQUIRED_ACCOUNT}; found ${auth.login ?? "none"}`);
  if (!auth.scopes.includes("delete_repo")) {
    throw new Error("Missing GitHub delete_repo scope. Run exactly: gh auth refresh -h github.com -s delete_repo");
  }
  const repository = JSON.parse(await run("gh", ["repo", "view", config.repository, "--json", "nameWithOwner,visibility"])) as { nameWithOwner?: unknown; visibility?: unknown };
  if (repository.nameWithOwner !== config.repository) throw new Error(`Resolved repository identity differs from ${config.repository}`);
  if (repository.visibility !== "PRIVATE") throw new Error(`Existing repository ${config.repository} must be private`);

  await run("gh", ["repo", "delete", config.repository, "--yes"]);
  await run("gh", ["repo", "create", config.repository, "--private", "--disable-wiki", "--description", "Disposable deterministic Harness E2E fixture"]);
  await reset(config);
}

export async function reset(config: HarnessConfig): Promise<void> {
  await mkdir(config.runtimeRoot, { recursive: true });
  await verifyRemote(config.repository);
  await verifyConfiguredLocalTarget(config);
  const seed = await createSeedRepository(config.runtimeRoot);
  try {
    await closeOpenPullRequests(config.repository);
    await closeOpenIssues(config.repository);
    await resetRemoteRefs(config.repository, seed.root, seed.sha);
    await reconcileLabels(config.repository);
    await reconcileClone(config);
    await verifyFinalState(config, seed.sha);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
}

export async function resetLocal(config: HarnessConfig): Promise<void> {
  await mkdir(config.runtimeRoot, { recursive: true });
  await verifyRemote(config.repository);
  await reconcileClone(config);
}

async function verifyConfiguredLocalTarget(config: HarnessConfig): Promise<void> {
  if (await exists(config.cloneRoot)) {
    await verifyOwnership(config);
    await verifyCloneIdentity(config);
    return;
  }
  if (!await exists(config.ownershipPath)) return;
  const ownership = await readOwnership(config.ownershipPath);
  if (ownership.repository !== config.repository || resolve(ownership.cloneRoot) !== resolve(config.cloneRoot)) {
    throw new Error("Refusing destructive reset: harness ownership record does not match the configured repository and clone");
  }
}

async function verifyRemote(repository: string): Promise<void> {
  const value = JSON.parse(await run("gh", ["repo", "view", repository, "--json", "nameWithOwner,visibility,defaultBranchRef"])) as {
    nameWithOwner?: unknown; visibility?: unknown; defaultBranchRef?: { name?: unknown };
  };
  if (value.nameWithOwner !== repository) throw new Error(`Resolved repository identity differs from configured slug ${repository}`);
  if (value.visibility !== "PRIVATE") throw new Error(`Harness repository ${repository} must be private`);
  const defaultName = value.defaultBranchRef?.name;
  if (defaultName !== null && defaultName !== undefined && defaultName !== "" && defaultName !== "main") throw new Error(`Harness default branch must be main; found ${String(defaultName)}`);
}

async function createSeedRepository(runtimeRoot: string): Promise<{ root: string; sha: string }> {
  const parent = join(runtimeRoot, "seed-work");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "seed-"));
  await cp(repositoryFixtureRoot, root, { recursive: true });
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await mkdir(join(root, ".git", "harness-empty-hooks"), { recursive: true });
  await git(root, ["config", "core.hooksPath", join(root, ".git", "harness-empty-hooks")]);
  await git(root, ["config", "commit.gpgSign", "false"]);
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "--message", SEED_MESSAGE], {
    GIT_AUTHOR_NAME: "harness e2e", GIT_AUTHOR_EMAIL: "harness-e2e@invalid.example",
    GIT_COMMITTER_NAME: "harness e2e", GIT_COMMITTER_EMAIL: "harness-e2e@invalid.example",
    GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE,
  });
  return { root, sha: (await git(root, ["rev-parse", "HEAD"])).trim() };
}

async function closeOpenPullRequests(repository: string): Promise<void> {
  const rows = JSON.parse(await run("gh", ["pr", "list", "--repo", repository, "--state", "open", "--limit", "1000", "--json", "number"])) as { number?: unknown }[];
  for (const row of rows) {
    if (!Number.isInteger(row.number)) throw new Error("GitHub returned a malformed pull request number");
    await run("gh", ["pr", "close", String(row.number), "--repo", repository]);
  }
}

async function closeOpenIssues(repository: string): Promise<void> {
  const rows = JSON.parse(await run("gh", ["issue", "list", "--repo", repository, "--state", "open", "--limit", "1000", "--json", "number"])) as { number?: unknown }[];
  for (const row of rows) {
    if (!Number.isInteger(row.number)) throw new Error("GitHub returned a malformed issue number");
    await run("gh", ["issue", "close", String(row.number), "--repo", repository]);
  }
}

async function resetRemoteRefs(repository: string, seedRoot: string, seedSha: string): Promise<void> {
  const url = `https://github.com/${repository}.git`;
  await git(seedRoot, ["remote", "add", "origin", url]);
  const refs = parseRemoteRefs(await git(seedRoot, ["ls-remote", "--heads", "origin"]));
  const main = refs.get("main");
  const lease = main ? `--force-with-lease=refs/heads/main:${main}` : "--force";
  await git(seedRoot, ["push", lease, "origin", `${seedSha}:refs/heads/main`]);
  for (const [name, sha] of refs) {
    if (name === "main") continue;
    await git(seedRoot, ["push", `--force-with-lease=refs/heads/${name}:${sha}`, "origin", `:refs/heads/${name}`]);
  }
}

function parseRemoteRefs(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/.exec(line);
    if (!match) throw new Error("git ls-remote returned a malformed branch ref");
    refs.set(match[2]!, match[1]!);
  }
  return refs;
}

async function reconcileLabels(repository: string): Promise<void> {
  const current = JSON.parse(await run("gh", ["label", "list", "--repo", repository, "--limit", "1000", "--json", "name"])) as { name?: unknown }[];
  const expected = new Set(LABELS.map((label) => label.name.toLowerCase()));
  for (const row of current) {
    if (typeof row.name !== "string") throw new Error("GitHub returned a malformed label name");
    if (!expected.has(row.name.toLowerCase())) await run("gh", ["label", "delete", row.name, "--repo", repository, "--yes"]);
  }
  for (const label of LABELS) {
    await run("gh", ["label", "create", label.name, "--repo", repository, "--color", label.color, "--description", label.description, "--force"]);
  }
}

async function reconcileClone(config: HarnessConfig): Promise<void> {
  if (await exists(config.cloneRoot)) {
    await verifyOwnership(config);
    await verifyCloneIdentity(config);
    await removeHarnessWorktrees(config);
    await git(config.cloneRoot, ["fetch", "origin", "--prune"]);
  } else {
    if (await exists(config.ownershipPath)) {
      const ownership = await readOwnership(config.ownershipPath);
      if (resolve(ownership.cloneRoot) !== resolve(config.cloneRoot) || ownership.repository !== config.repository) throw new Error("Harness ownership record differs from configured clone");
    }
    await run("git", ["clone", `https://github.com/${config.repository}.git`, config.cloneRoot], { cwd: config.runtimeRoot });
    await writeOwnership(config);
  }
  await verifyCloneIdentity(config);
  await git(config.cloneRoot, ["checkout", "-B", "main", "origin/main"]);
  await git(config.cloneRoot, ["reset", "--hard", "origin/main"]);
  await git(config.cloneRoot, ["clean", "-ffdx"]);
}

async function removeHarnessWorktrees(config: HarnessConfig): Promise<void> {
  const output = await git(config.cloneRoot, ["worktree", "list", "--porcelain"]);
  for (const path of harnessWorktreePaths(output, config.runtimeRoot, config.cloneRoot)) {
    await git(config.cloneRoot, ["worktree", "remove", "--force", path]);
  }
  await git(config.cloneRoot, ["worktree", "prune"]);
}

export function harnessWorktreePaths(output: string, runtimeRoot: string, cloneRoot: string): string[] {
  const clone = resolve(cloneRoot);
  const ownedRoot = resolve(runtimeRoot, "worktrees");
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith("worktree ")) continue;
    const candidate = resolve(line.slice("worktree ".length));
    if (candidate.toLowerCase() === clone.toLowerCase()) continue;
    if (!contains(ownedRoot, candidate) || candidate.toLowerCase() === ownedRoot.toLowerCase()) {
      throw new Error(`Refusing reset cleanup for registered worktree outside the dedicated harness worktree root: ${candidate}`);
    }
    paths.push(candidate);
  }
  return paths;
}

async function verifyOwnership(config: HarnessConfig): Promise<void> {
  if (!await exists(config.ownershipPath)) throw new Error(`Refusing destructive reset: missing harness ownership record ${config.ownershipPath}`);
  const ownership = await readOwnership(config.ownershipPath);
  if (ownership.repository !== config.repository || resolve(ownership.cloneRoot) !== resolve(config.cloneRoot)) {
    throw new Error("Refusing destructive reset: harness ownership record does not match the configured repository and clone");
  }
}

async function verifyCloneIdentity(config: HarnessConfig): Promise<void> {
  const inside = (await git(config.cloneRoot, ["rev-parse", "--show-toplevel"])).trim();
  if (resolve(inside) !== resolve(config.cloneRoot)) throw new Error("Refusing destructive reset: clone root is not the Git worktree root");
  const origin = (await git(config.cloneRoot, ["remote", "get-url", "origin"])).trim();
  const slug = parseGitHubSlug(origin);
  if (slug !== config.repository) throw new Error(`Refusing destructive reset: clone origin resolves to ${slug ?? "a non-GitHub repository"}, expected ${config.repository}`);
  const resolved = JSON.parse(await run("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: config.cloneRoot })) as { nameWithOwner?: unknown };
  if (resolved.nameWithOwner !== config.repository) throw new Error("Refusing destructive reset: GitHub resolved the clone to a different repository");
}

function parseGitHubSlug(url: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function verifyFinalState(config: HarnessConfig, seedSha: string): Promise<void> {
  const localHead = (await git(config.cloneRoot, ["rev-parse", "HEAD"])).trim();
  const branch = (await git(config.cloneRoot, ["branch", "--show-current"])).trim();
  const status = await git(config.cloneRoot, ["status", "--porcelain"]);
  if (localHead !== seedSha || branch !== "main" || status !== "") throw new Error("Local reset postcondition failed");
  const worktrees = harnessWorktreePaths(await git(config.cloneRoot, ["worktree", "list", "--porcelain"]), config.runtimeRoot, config.cloneRoot);
  if (worktrees.length !== 0) throw new Error("Local reset left an auto-run worktree registered");
  const refs = parseRemoteRefs(await git(config.cloneRoot, ["ls-remote", "--heads", "origin"]));
  if (refs.size !== 1 || refs.get("main") !== seedSha) throw new Error("Remote branch reset postcondition failed");
  const prs = JSON.parse(await run("gh", ["pr", "list", "--repo", config.repository, "--state", "open", "--limit", "1", "--json", "number"])) as unknown[];
  const issues = JSON.parse(await run("gh", ["issue", "list", "--repo", config.repository, "--state", "open", "--limit", "1", "--json", "number"])) as unknown[];
  if (prs.length !== 0 || issues.length !== 0) throw new Error("GitHub issue or pull request reset postcondition failed");
}

async function writeOwnership(config: HarnessConfig): Promise<void> {
  const value: OwnershipRecord = { schemaVersion: 1, repository: config.repository, cloneRoot: resolve(config.cloneRoot) };
  await mkdir(dirname(config.ownershipPath), { recursive: true });
  await writeFile(config.ownershipPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readOwnership(path: string): Promise<OwnershipRecord> {
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<OwnershipRecord>;
  if (value.schemaVersion !== 1 || typeof value.repository !== "string" || typeof value.cloneRoot !== "string") throw new Error("Malformed harness ownership record");
  return value as OwnershipRecord;
}

function parseAuth(output: string): { login?: string; scopes: readonly string[] } {
  const value = JSON.parse(output) as { hosts?: { [host: string]: { active?: unknown; login?: unknown; scopes?: unknown }[] } };
  const row = value.hosts?.["github.com"]?.find((candidate) => candidate.active === true);
  return { ...(typeof row?.login === "string" ? { login: row.login } : {}), scopes: typeof row?.scopes === "string" ? row.scopes.split(",").map((scope) => scope.trim()) : [] };
}

async function git(cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<string> {
  return run("git", args, { cwd, ...(env ? { env } : {}) });
}

async function run(file: string, args: readonly string[], options: { cwd?: string; env?: Readonly<Record<string, string>> } = {}): Promise<string> {
  try {
    const result = await execFileAsync(file, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ? { ...process.env, ...options.env } : process.env,
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") throw new Error(`${file} ${args[0] ?? ""} failed: ${error.stderr.trim()}`);
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; }
  catch { return false; }
}
