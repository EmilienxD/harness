import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CheckoutSetupError, ManualCheckouts, validateCheckoutSelection } from "../../src/platform/checkouts.js";
import { ProcessGitClient } from "../../src/git/client.js";
import { worktreeGitMetadataRoots, WorktreeRunWorkspaces } from "../../src/auto/worktree.js";
import type { SetupCommandRequest } from "../../src/git/worktree.js";

const run = promisify(execFile);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "aboard-checkouts-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(directory, "project");
  await mkdir(root);
  const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  await git("init", "--initial-branch", "main");
  await git("config", "user.email", "test@example.test");
  await git("config", "user.name", "Aboard test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  await git("config", "core.hooksPath", join(directory, "no-hooks"));
  await writeFile(join(root, ".gitignore"), ".abd/\n.harness/\n");
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  await mkdir(join(root, ".abd"));
  await writeFile(join(root, ".abd", "scaffold.json"), "{}\n");
  await mkdir(join(root, ".harness"));
  await writeFile(join(root, ".harness", "config.json"), '{"version":1}\n');
  const calls: SetupCommandRequest[] = [];
  let reserved: string | undefined;
  const create = (workspaceRoot = root, setup = async (request: SetupCommandRequest) => { calls.push(request); }) => new ManualCheckouts({
    workspaceRoot, storageRoot: join(directory, "storage"), settings: () => ({ root: "", setupTimeoutSeconds: 12 }),
    reserved: (path) => path === reserved, log: () => {}, setup: { run: setup },
  });
  return { directory, root, git, create, calls, reserve: (path: string) => { reserved = path; } };
}

test("manual checkout creation uses numbered siblings, exact local HEAD, and shared project configuration", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "tracked.txt"), "local committed change\n");
  await f.git("commit", "-am", "local only");
  const sha = await new ProcessGitClient(f.root).headSha();
  await writeFile(join(f.root, "tracked.txt"), "uncommitted\n");
  const service = f.create();
  const target = await service.prepare({ kind: "new", branch: "feature/test" });
  assert.equal(target, join(f.directory, "project-1"));
  assert.equal(await new ProcessGitClient(target).headSha(), sha);
  assert.equal(await readFile(join(target, "tracked.txt"), "utf8"), "local committed change\n");
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "uncommitted\n");
  assert.equal(await readFile(join(target, ".harness", "config.json"), "utf8"), '{"version":1}\n');
  assert.equal(await service.prepare({ kind: "existing", path: target }), target);
  assert.equal(await new ProcessGitClient(f.root).currentBranch(), "main");
});

test("launching from a linked checkout anchors numbering to the main checkout, not a nested suffix", async (t) => {
  const f = await fixture(t);
  const first = await f.create().prepare({ kind: "new", branch: "first" });
  const second = await f.create(first).prepare({ kind: "new", branch: "second" });
  assert.equal(second, join(f.directory, "project-2"));
  const provider = new WorktreeRunWorkspaces({ workspaceRoot: first, mainCheckoutRoot: f.root, git: new ProcessGitClient(first), gitFor: (cwd) => new ProcessGitClient(cwd), settings: () => ({ enabled: true, root: "", keep: true, setupTimeoutSeconds: 12 }), notify: () => {} });
  assert.equal(provider.nextRoot({ enabled: true, root: "", keep: true, setupTimeoutSeconds: 12 }), join(f.directory, "project-3"));
  assert.ok((await worktreeGitMetadataRoots(second, first)).length > 0);
});

test("existing branches require explicit reuse, and checked-out branches are never forced", async (t) => {
  const f = await fixture(t);
  await f.git("branch", "existing");
  const service = f.create();
  await assert.rejects(service.prepare({ kind: "new", branch: "existing" }), /already exists/);
  assert.equal((await new ProcessGitClient(f.root).worktrees()).length, 1);
  const path = await service.prepare({ kind: "new", branch: "existing", useExistingBranch: true });
  assert.equal(await new ProcessGitClient(path).currentBranch(), "existing");
  await assert.rejects(service.prepare({ kind: "new", branch: "existing", useExistingBranch: true }), /already checked out/);
  await assert.rejects(service.prepare({ kind: "new", branch: "main" }), /already checked out/);
});

test("invalid branches and starting points fail before checkout creation", async (t) => {
  const f = await fixture(t);
  const service = f.create();
  for (const branch of ["-bad", "bad branch", "@{-1}", "a..b"]) await assert.rejects(service.prepare({ kind: "new", branch }), /branch name/);
  await assert.rejects(service.prepare({ kind: "new", branch: "fine", startPoint: "missing-ref" }), /Cannot resolve/);
  assert.equal((await new ProcessGitClient(f.root).worktrees()).length, 1);
});

test("setup runs once per new checkout and never for existing or dirty checkouts", async (t) => {
  const f = await fixture(t);
  for (const suffix of ["sh", "ps1"]) await writeFile(join(f.root, ".abd", `session-setup.${suffix}`), "echo setup\n");
  const service = f.create();
  const path = await service.prepare({ kind: "new", branch: "setup" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.cwd, path);
  assert.equal(f.calls[0]?.timeoutMs, 12000);
  assert.equal(f.calls[0]?.env.ABOARD_PROJECT_ROOT, f.root);
  await writeFile(join(path, "tracked.txt"), "work in progress\n");
  await service.prepare({ kind: "existing", path });
  await service.prepare({ kind: "current" });
  assert.equal(f.calls.length, 1);
  assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "work in progress\n");
});

test("failed setup retains the checkout across service restarts and requires an explicit retry", async (t) => {
  const f = await fixture(t);
  for (const suffix of ["sh", "ps1"]) await writeFile(join(f.root, ".abd", `session-setup.${suffix}`), "echo setup\n");
  let preparationId: string | undefined;
  const broken = f.create(f.root, async (request) => { preparationId = request.env.ABOARD_RUN_ID; throw new Error("installation failed"); });
  await assert.rejects(broken.prepare({ kind: "new", branch: "retry" }), CheckoutSetupError);
  const target = join(f.directory, "project-1");
  assert.equal((await stat(target)).isDirectory(), true);
  const recovered = f.create();
  assert.equal((await recovered.choices()).entries.find((entry) => entry.path.replaceAll("\\", "/") === target.replaceAll("\\", "/"))?.preparation, "failed");
  await assert.rejects(recovered.prepare({ kind: "existing", path: target }), CheckoutSetupError);
  assert.equal(await recovered.retrySetup(target), target);
  assert.equal(await recovered.prepare({ kind: "existing", path: target }), target);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.env.ABOARD_RUN_ID, preparationId);
  assert.equal((await new ProcessGitClient(f.root).worktrees()).length, 2);
});

test("checkout selection is repository-scoped and refuses active Auto Run targets", async (t) => {
  const f = await fixture(t);
  const service = f.create();
  await assert.rejects(service.prepare({ kind: "existing", path: f.directory }), /no longer registered/);
  f.reserve(f.root);
  await assert.rejects(service.prepare({ kind: "current" }), /reserved/);
  const target = await service.prepare({ kind: "new", branch: "other" });
  f.reserve(target);
  await assert.rejects(service.prepare({ kind: "existing", path: target }), /reserved/);
});

test("a stale registered path cannot launch into a replacement repository", async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const target = await service.prepare({ kind: "new", branch: "replaced" });
  await rm(join(target, ".git"));
  await run("git", ["init", target], { windowsHide: true });
  await assert.rejects(service.prepare({ kind: "existing", path: target }), /no longer belongs/);
  assert.equal((await service.choices()).entries.find((entry) => entry.branch === "replaced")?.available, false);
});

test("detached checkouts, remote refs, and occupied sibling directories are supported without fetching",  async (t) => {
  const f = await fixture(t);
  await f.git("update-ref", "refs/remotes/origin/feature", "HEAD");
  await mkdir(join(f.directory, "project-1"));
  const target = await f.create().prepare({ kind: "new", branch: "remote", startPoint: "origin/feature" });
  assert.equal(target, join(f.directory, "project-2"));
  await f.git("checkout", "--detach");
  assert.equal(await f.create().prepare({ kind: "current" }), f.root);
  assert.equal(await f.create().prepare({ kind: "new", branch: "from-detached" }), join(f.directory, "project-3"));
});

test("non-Git folders retain current-folder launch and explain unavailable creation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aboard-no-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new ManualCheckouts({ workspaceRoot: directory, storageRoot: join(directory, "storage"), settings: () => ({ root: "", setupTimeoutSeconds: 12 }), reserved: () => false, log: () => {} });
  assert.equal(await service.prepare({ kind: "current" }), directory);
  assert.match((await service.choices()).error!, /Git repository/);
});

test("setup retries across windows cannot execute the same preparation concurrently", async (t) => {
  const f = await fixture(t);
  for (const suffix of ["sh", "ps1"]) await writeFile(join(f.root, ".abd", `session-setup.${suffix}`), "echo setup\n");
  await assert.rejects(f.create(f.root, async () => { throw new Error("fail"); }).prepare({ kind: "new", branch: "retry-lock" }), CheckoutSetupError);
  const path = join(f.directory, "project-1");
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { finish = resolve; });
  const first = f.create(f.root, async () => { entered(); await paused; });
  const running = first.retrySetup(path);
  try {
    await started;
    await assert.rejects(f.create().retrySetup(path), /already in progress/);
  } finally { finish(); }
  assert.equal(await running, path);
  assert.equal(f.calls.length, 0);
});

test("real setup scripts run in the new checkout with the shared environment contract", async (t) => {
  const f = await fixture(t);
  const source = process.platform === "win32"
    ? '$result = @{ cwd = (Get-Location).Path; project = $env:ABOARD_PROJECT_ROOT; session = $env:ABOARD_SESSION_PATH; branch = $env:ABOARD_SESSION_BRANCH } | ConvertTo-Json\nSet-Content -LiteralPath "setup-result.json" -Value $result\n'
    : `node -e 'require("fs").writeFileSync("setup-result.json", JSON.stringify({cwd:process.cwd(),project:process.env.ABOARD_PROJECT_ROOT,session:process.env.ABOARD_SESSION_PATH,branch:process.env.ABOARD_SESSION_BRANCH}))'\n`;
  await writeFile(join(f.root, ".abd", process.platform === "win32" ? "session-setup.ps1" : "session-setup.sh"), source);
  const service = new ManualCheckouts({ workspaceRoot: f.root, storageRoot: join(f.directory, "storage"), settings: () => ({ root: "", setupTimeoutSeconds: 12 }), reserved: () => false, log: () => {} });
  const path = await service.prepare({ kind: "new", branch: "real-setup" });
  const result = JSON.parse((await readFile(join(path, "setup-result.json"), "utf8")).replace(/^\uFEFF/u, "")) as Record<string, string>;
  assert.equal(result.cwd, path);
  assert.equal(result.project, f.root);
  assert.equal(result.session, path);
  assert.equal(result.branch, "real-setup");
  assert.equal((await new ProcessGitClient(path).status()).entries.some((entry) => entry.path === "setup-result.json"), true, "manual setup may leave local files without acquiring Auto Run's clean-checkout rule");
});

test("a checkout claimed after path selection is not marked as failed by the losing creator", async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const target = join(f.directory, "project-1");
  await assert.rejects(service.prepare({ kind: "new", branch: "loser" }, () => {
    execFileSync("git", ["worktree", "add", "-b", "winner", target, "HEAD"], { cwd: f.root, windowsHide: true, stdio: "pipe" });
  }));
  assert.equal(await service.prepare({ kind: "existing", path: target }), target);
  assert.equal(await new ProcessGitClient(target).currentBranch(), "winner");
  assert.equal(await service.branchExists("loser"), false);
});

test("losing Git's checkout race does not leave retryable setup on the external checkout", async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const target = join(f.directory, "project-1");
  const add = ProcessGitClient.prototype.addWorktree;
  t.mock.method(ProcessGitClient.prototype, "addWorktree", async function (this: ProcessGitClient, path: string, branch: string, start?: string) {
    await f.git("worktree", "add", "-b", "external", path, "HEAD");
    return add.call(this, path, branch, start);
  });
  await assert.rejects(service.prepare({ kind: "new", branch: "loser" }));
  assert.equal(await service.prepare({ kind: "existing", path: target }), target);
  await assert.rejects(service.retrySetup(target), /no failed setup/);
  assert.equal(f.calls.length, 0);
});

test("delegations and reopen from checkout subdirectories use the checkout launch authority", async (t) => {
  const f = await fixture(t);
  const { FileLaunchConfigurationSource } = await import("../../src/platform/launch-configuration.js");
  const target = await f.create().prepare({ kind: "new", branch: "nested-config" });
  const nested = join(target, "src", "nested");
  await mkdir(nested, { recursive: true });
  const providers = ["claude", "chatgpt", "pi"] as const;
  await writeFile(join(target, ".harness", "config.json"), JSON.stringify({ version: 1, providers: Object.fromEntries(providers.map((provider) => [provider, { command: [`target-${provider}`] }])) }));
  const source = new FileLaunchConfigurationSource(join(f.root, ".harness", "config.json"));
  for (const provider of providers) {
    assert.deepEqual(await source.getDelegationForWorktree(provider, "general", nested), await source.getDelegationForWorktree(provider, "general", target));
    assert.deepEqual(await source.getForWorktree(provider, "interactive", nested), await source.getForWorktree(provider, "interactive", target));
  }
  await writeFile(join(target, ".harness", "config.json"), "invalid JSON");
  await assert.rejects(source.getDelegationForWorktree("claude", "general", nested), /invalid JSON/);
});

test("checkout configuration resolution preserves an explicitly opened subfolder project", async (t) => {
  const f = await fixture(t);
  const { FileLaunchConfigurationSource } = await import("../../src/platform/launch-configuration.js");
  const project = join(f.root, "app");
  const cwd = join(project, "src");
  await mkdir(join(project, ".harness"), { recursive: true });
  await mkdir(cwd);
  const path = join(project, ".harness", "config.json");
  await writeFile(path, JSON.stringify({ version: 1, providers: { claude: { command: ["app-claude"] } } }));
  const source = new FileLaunchConfigurationSource(path);
  assert.deepEqual(await source.getForWorktree("claude", "interactive", cwd), await source.getFor("claude", "interactive"));
  await rm(join(f.root, ".git"), { recursive: true, force: true });
  assert.deepEqual(await source.getDelegationForWorktree("claude", "general", cwd), await source.getDelegationFor("claude", "general"));
});

test("checkout messages validate shape without accepting missing branch names or invalid options", () => {
  assert.deepEqual(validateCheckoutSelection(undefined), { kind: "current" });
  assert.deepEqual(validateCheckoutSelection({ kind: "new", branch: " test " }), { kind: "new", branch: "test" });
  for (const value of [null, {}, { kind: "new", branch: " " }, { kind: "existing", path: 42 }, { kind: "new", branch: "test", startPoint: [] }, { kind: "new", branch: "test", useExistingBranch: "yes" }]) assert.throws(() => validateCheckoutSelection(value));
});
