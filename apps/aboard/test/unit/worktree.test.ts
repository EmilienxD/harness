import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  RunWorkspaceError,
  WorktreeRunWorkspaces,
  hasSetupCommands,
  isolationProtectedPaths,
  runWorkspacePath,
  samePath,
  setupCommandLine,
  setupCommandPath,
  worktreeGitMetadataRoots,
  type RunWorkspaceDirectories,
  type SetupCommandRequest,
} from "../../src/auto/worktree.js";
import type { WorktreeSettings } from "../../src/domain/auto-run.js";
import type { GitClient, GitStatus, GitWorktree } from "../../src/git/client.js";

const PROJECT = resolve("C:/work/aboard");
const ENABLED: WorktreeSettings = { enabled: true, root: "", keep: false, setupTimeoutSeconds: 600 };

test("a run's checkout is a short, ordinary-looking sibling of the project", () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  assert.equal(dirname(path), dirname(PROJECT));
  assert.equal(basename(path), "aboard-1");
  assert.ok(!path.toLowerCase().includes("worktree"), `${path} must not announce what it is`);
  assert.ok(!path.toLowerCase().includes("session"), `${path} must not announce what it is`);
});

test("a run's checkout uses the first available sibling index", () => {
  const occupied = new Set([
    join(dirname(PROJECT), "aboard-1"),
    join(dirname(PROJECT), "aboard-2"),
  ]);
  const path = runWorkspacePath({ workspaceRoot: PROJECT, exists: (candidate) => occupied.has(candidate) });
  assert.equal(path, join(dirname(PROJECT), "aboard-3"));
});

test("a configured root is honoured, and one inside the project is refused", () => {
  const custom = runWorkspacePath({ workspaceRoot: PROJECT, root: resolve("D:/checkouts") });
  assert.equal(custom, join(resolve("D:/checkouts"), "aboard-1"));
  // A relative root resolves against the project, which is exactly how a user
  // writes "next to it"; and how they could accidentally write "inside it".
  assert.equal(
    runWorkspacePath({ workspaceRoot: PROJECT, root: "../elsewhere" }),
    join(resolve(PROJECT, "../elsewhere"), "aboard-1"),
  );
  for (const inside of [".abd/checkouts", "build", "."]) {
    assert.throws(
      () => runWorkspacePath({ workspaceRoot: PROJECT, root: inside }),
      RunWorkspaceError,
      `${inside} is inside the project and must be refused`,
    );
  }
});

test("isolation expresses the protected checkout as provider-neutral paths", () => {
  assert.deepEqual(isolationProtectedPaths(PROJECT), [PROJECT]);
  assert.deepEqual(isolationProtectedPaths(resolve("a,b")), [resolve("a,b")]);
});

test("an untouched setup file asks for nothing", () => {
  assert.equal(hasSetupCommands(""), false);
  assert.equal(hasSetupCommands("# only a comment\n\n#   and another\n"), false);
  assert.equal(hasSetupCommands("<#\nnpm ci\n#>\n"), false, "a PowerShell block comment is not a command");
  assert.equal(hasSetupCommands("# comment\nnpm ci\n"), true);
  assert.equal(hasSetupCommands("<# one line #>\nnpm ci\n"), true);
});

test("the setup file and its interpreter follow the platform", () => {
  assert.equal(setupCommandPath("win32"), ".abd/session-setup.ps1");
  assert.equal(setupCommandPath("linux"), ".abd/session-setup.sh");
  assert.deepEqual(setupCommandLine("C:/p/.abd/session-setup.ps1", "win32"), {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/p/.abd/session-setup.ps1"],
  });
  assert.deepEqual(setupCommandLine("/p/.abd/session-setup.sh", "darwin"), { command: "bash", args: ["/p/.abd/session-setup.sh"] });
});

interface FakeGitOptions {
  readonly branches?: readonly string[];
  readonly remoteBranches?: readonly string[];
  readonly ignored?: readonly string[];
  readonly trackedRuntime?: readonly string[];
  readonly worktrees?: readonly GitWorktree[];
  readonly dirty?: readonly string[];
  readonly removeFails?: boolean;
}

interface FakeGit {
  readonly client: GitClient;
  readonly calls: string[];
}

function fakeGit(options: FakeGitOptions = {}): FakeGit {
  const calls: string[] = [];
  const worktrees = [...(options.worktrees ?? [])];
  const branches = new Set(options.branches ?? ["main"]);
  const client = {
    currentBranch: async () => "main",
    defaultBranch: async () => "main",
    status: async (): Promise<GitStatus> => ({
      branch: "run/test",
      entries: (options.dirty ?? []).map((path) => ({ status: "??", path })),
    }),
    codebase: async () => ({ sourceFileCount: 1, languages: ["ts"], commitCount: 1 }),
    headSha: async () => "abc1234",
    branchExists: async (branch: string) => branches.has(branch),
    existingBranches: async (names: readonly string[]) => ({
      local: new Set(names.filter((name) => branches.has(name))),
      remote: new Set(names.filter((name) => (options.remoteBranches ?? ["main"]).includes(name))),
    }),
    remoteBranchExists: async (branch: string) => (options.remoteBranches ?? ["main"]).includes(branch),
    fetch: async () => { calls.push("fetch"); },
    checkout: async (branch: string) => { calls.push(`checkout ${branch}`); },
    createBranch: async () => { calls.push("createBranch"); },
    deleteBranch: async () => { calls.push("deleteBranch"); },
    fastForward: async () => { calls.push("fastForward"); },
    mergeFromRemote: async () => true,
    add: async () => { calls.push("add"); },
    commit: async () => "abc1234",
    push: async () => { calls.push("push"); },
    isPushed: async () => true,
    ignoredPaths: async (paths: readonly string[]) => {
      const ignored = new Set(options.ignored ?? paths);
      return paths.filter((path) => ignored.has(path));
    },
    trackedPathsUnder: async (ref: string, directory: string) => {
      calls.push(`trackedPathsUnder ${ref} ${directory}`);
      return [...(options.trackedRuntime ?? [])];
    },
    worktrees: async () => [...worktrees],
    addWorktree: async (path: string, branch: string, startPoint?: string) => {
      calls.push(`addWorktree ${path} ${branch}${startPoint === undefined ? "" : ` ${startPoint}`}`);
      worktrees.push({ path, branch });
    },
    removeWorktree: async (path: string, force: boolean) => {
      calls.push(`removeWorktree ${path}${force ? " --force" : ""}`);
      if (options.removeFails === true) throw new Error("the checkout is in use");
      const index = worktrees.findIndex((worktree) => samePath(worktree.path, path));
      if (index >= 0) worktrees.splice(index, 1);
    },
    // The SHA-aware surface belongs to recovery and cleanup, not to workspaces.
    branchSha: async () => undefined,
    remoteBranchSha: async () => undefined,
    aheadBehind: async () => ({ ahead: 0, behind: 0 }),
    isAncestor: async () => true,
    treeSha: async () => undefined,
    commitDetails: async () => undefined,
    stagedTreeSha: async () => "tree000000000000000000000000000000000000",
    resetMixed: async () => undefined,
    workingTreeMatchesCommit: async () => false,
    deleteBranchAt: async () => false,
    deleteRemoteBranchAt: async () => false,
  } satisfies GitClient;
  return { client, calls };
}

interface Fixture {
  readonly provider: WorktreeRunWorkspaces;
  readonly git: FakeGit;
  readonly notifications: string[];
  readonly setups: SetupCommandRequest[];
  readonly created: string[];
  readonly removed: string[];
  readonly settings: { -readonly [Key in keyof WorktreeSettings]: WorktreeSettings[Key] };
}

function fixture(options: {
  readonly workspaceRoot?: string;
  readonly settings?: Partial<WorktreeSettings>;
  readonly git?: FakeGitOptions;
  readonly setupFile?: string;
  readonly setupFails?: boolean | "once";
  readonly existingDirectories?: readonly string[];
  readonly requireEnforceableIsolation?: (protectedPaths: readonly string[]) => void;
} = {}): Fixture {
  const git = fakeGit(options.git);
  const notifications: string[] = [];
  const setups: SetupCommandRequest[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const settings: { -readonly [Key in keyof WorktreeSettings]: WorktreeSettings[Key] } = { ...ENABLED, ...options.settings };
  const present = new Set(options.existingDirectories ?? []);
  const directories: RunWorkspaceDirectories = {
    exists: async (path) => present.has(path),
    create: async (path) => { created.push(path); present.add(path); },
    remove: async (path) => { removed.push(path); present.delete(path); },
  };
  const provider = new WorktreeRunWorkspaces({
    workspaceRoot: options.workspaceRoot ?? PROJECT,
    git: git.client,
    gitFor: () => git.client,
    settings: () => settings,
    notify: (message) => notifications.push(message),
    platform: "win32",
    directories,
    readSetupFile: async () => options.setupFile,
    resolveGitMetadataRoots: async (worktreeRoot) => [join(worktreeRoot, ".git-metadata")],
    ...(options.requireEnforceableIsolation === undefined ? {} : { requireEnforceableIsolation: options.requireEnforceableIsolation }),
    setup: {
      run: async (request) => {
        setups.push(request);
        if (options.setupFails === true || (options.setupFails === "once" && setups.length === 1)) throw new Error("npm ci failed");
      },
    },
  });
  return { provider, git, notifications, setups, created, removed, settings };
}

const REQUEST = { runId: "run_test", sessionBranch: "run/test", base: "main" } as const;

test("worktree mode off leaves the run in the user's own checkout", async () => {
  const { provider, git } = fixture({ settings: { enabled: false } });
  const workspace = await provider.prepare(REQUEST);
  assert.equal(workspace.isolated, false);
  assert.equal(workspace.root, PROJECT);
  assert.deepEqual(workspace.protectedPaths, [], "an in-place run has nothing to fence itself out of");
  assert.deepEqual(git.calls, [], "no checkout is created, and git is not asked about one");
});

test("a provider that cannot fence the project refuses worktree mode before creating anything", async () => {
  // Claude carries its deny rules in one comma-separated --disallowedTools
  // value, so a project path with a comma cannot be represented. An interrupted
  // run leaves its checkout behind, so this has to fail before one exists.
  const context = fixture({
    workspaceRoot: resolve("C:/work/aboard,unsafe"),
    requireEnforceableIsolation: () => { throw new Error("Claude cannot encode a protected path containing a comma"); },
  });

  await assert.rejects(context.provider.prepare(REQUEST), /cannot isolate.*comma/iu);
  assert.deepEqual(context.git.calls, []);
  assert.deepEqual(context.created, []);
});

test("a provider that accepts the project path prepares the checkout as usual", async () => {
  const seen: (readonly string[])[] = [];
  const context = fixture({ requireEnforceableIsolation: (protectedPaths) => { seen.push(protectedPaths); } });

  const workspace = await context.provider.prepare(REQUEST);
  assert.equal(workspace.isolated, true);
  assert.deepEqual(seen, [isolationProtectedPaths(PROJECT)]);
});

test("preparing a checkout creates it from the local base and installs into it", async () => {
  const { provider, git, setups, notifications } = fixture({ setupFile: "npm ci\n" });
  const workspace = await provider.prepare(REQUEST);
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  assert.equal(workspace.root, path);
  assert.equal(workspace.isolated, true);
  assert.deepEqual(workspace.protectedPaths, isolationProtectedPaths(PROJECT));
  assert.deepEqual(workspace.writableRoots, [join(path, ".git-metadata")]);
  assert.ok(git.calls.includes(`addWorktree ${path} run/test main`), git.calls.join(", "));
  // The setup command runs in the new checkout, from the project's own copy of
  // the file; the one the user edits, not whatever the branch carries.
  assert.equal(setups.length, 1);
  assert.equal(setups[0]?.cwd, path);
  assert.equal(setups[0]?.args.at(-1), join(PROJECT, ".abd", "session-setup.ps1"));
  assert.equal(setups[0]?.env.ABOARD_PROJECT_ROOT, PROJECT);
  assert.equal(setups[0]?.env.ABOARD_SESSION_BRANCH, "run/test");
  assert.ok(notifications.some((message) => message.includes(path)));
});

test("preparing a checkout uses the path frozen when the run was planned", async () => {
  const { provider, git } = fixture();
  const checkoutRoot = join(dirname(PROJECT), "aboard-2");
  const workspace = await provider.prepare({ ...REQUEST, checkoutRoot });
  assert.equal(workspace.root, checkoutRoot);
  assert.ok(git.calls.includes(`addWorktree ${checkoutRoot} run/test main`), git.calls.join(", "));
});

test("setup uses the run's frozen timeout instead of live settings", async () => {
  const context = fixture({ settings: { setupTimeoutSeconds: 5 }, setupFile: "npm ci\n" });
  await context.provider.prepare({
    ...REQUEST,
    worktree: { ...ENABLED, setupTimeoutSeconds: 37 },
  });
  assert.equal(context.setups[0]?.timeoutMs, 37_000);
});

test("linked-worktree Git metadata exposes only the paths required to commit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-git-metadata-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  const checkout = join(root, "checkout");
  const gitDirectory = join(project, ".git", "worktrees", "checkout");
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(join(gitDirectory, "commondir"), "../..\n");

  assert.deepEqual(await worktreeGitMetadataRoots(checkout, project), [
    gitDirectory,
    join(project, ".git", "objects"),
    join(project, ".git", "refs", "heads"),
    join(project, ".git", "logs", "refs", "heads"),
    join(project, ".git", "packed-refs"),
    join(project, ".git", "packed-refs.lock"),
  ]);
});

test("a checkout falls back to the remote base when no local base ref exists", async () => {
  const { provider, git } = fixture({ git: { branches: [] } });
  await provider.prepare(REQUEST);
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  assert.ok(git.calls.includes(`addWorktree ${path} run/test origin/main`), git.calls.join(", "));
});

test("an existing session branch is checked out rather than created a second time", async () => {
  const { provider, git } = fixture({ git: { branches: ["run/test"] } });
  await provider.prepare(REQUEST);
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  assert.ok(git.calls.includes(`addWorktree ${path} run/test`), git.calls.join(", "));
});

test("a resumed run re-attaches to its checkout without setting it up again", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  const { provider, git, setups } = fixture({
    setupFile: "npm ci\n",
    // Spelled as git reports it on Windows, which is not how Node spells it.
    git: { worktrees: [{ path: path.split(sep).join("/"), branch: "run/test" }] },
    // A resumed run's checkout legitimately holds an address's work.
    ...{},
  });
  const workspace = await provider.prepare({ ...REQUEST, prepared: true });
  assert.equal(workspace.root, path);
  assert.equal(setups.length, 0, "installing again would undo work in flight");
  assert.ok(!git.calls.some((call) => call.startsWith("addWorktree")), git.calls.join(", "));
});

test("an unrelated checkout at the run path is never removed as an incomplete retry", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  const { provider, git } = fixture({
    git: { worktrees: [{ path, branch: "user/in-progress" }] },
  });

  await assert.rejects(provider.prepare(REQUEST), /user\/in-progress.*run\/test/u);
  assert.ok(!git.calls.some((call) => call.startsWith("removeWorktree")), git.calls.join(", "));
});

test("a failing setup command refuses the run rather than starting agents in a half-installed tree", async () => {
  const { provider } = fixture({ setupFile: "npm ci\n", setupFails: true });
  await assert.rejects(provider.prepare(REQUEST), (error: unknown) => {
    assert.ok(error instanceof RunWorkspaceError);
    assert.match(error.message, /session-setup\.ps1 failed/u);
    return true;
  });
});

test("retrying a failed first setup recreates and fully prepares its checkout", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  const { provider, git, setups } = fixture({
    setupFile: "npm ci\n",
    setupFails: "once",
    git: { dirty: ["setup-leftover.txt"] },
  });

  await assert.rejects(provider.prepare(REQUEST), /session-setup\.ps1 failed/u);
  await assert.rejects(provider.prepare(REQUEST), /setup-leftover\.txt/u);

  assert.equal(setups.length, 2, "the replacement checkout runs setup from the beginning");
  assert.equal(git.calls.filter((call) => call.startsWith("addWorktree")).length, 2);
  assert.ok(git.calls.includes(`removeWorktree ${path} --force`), git.calls.join(", "));
});

test("setup leftovers the run would commit refuse it too", async () => {
  const { provider } = fixture({ setupFile: "npm ci\n", git: { dirty: [".env", "notes.txt"] } });
  await assert.rejects(provider.prepare(REQUEST), (error: unknown) => {
    assert.ok(error instanceof RunWorkspaceError);
    // `git add -A` would sweep these into the first issue's commit.
    assert.match(error.message, /\.env/u);
    return true;
  });
});

test("a directory in the way is reported rather than checked out over", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  const { provider } = fixture({ existingDirectories: [path] });
  await assert.rejects(provider.prepare(REQUEST), RunWorkspaceError);
});

test("a drained run's checkout is removed; an interrupted one is left where the user was sent", async () => {
  const drained = fixture();
  const workspace = await drained.provider.prepare(REQUEST);
  assert.equal(await drained.provider.release(workspace, "drained"), undefined);
  assert.ok(drained.git.calls.includes(`removeWorktree ${workspace.root} --force`));
  assert.deepEqual(drained.removed, [workspace.root], "cleanup never targets the checkout's parent directory");

  const parked = fixture();
  const kept = await parked.provider.prepare(REQUEST);
  assert.deepEqual(await parked.provider.release(kept, "interrupted"), { path: kept.root, reason: "left-for-the-user" });
  assert.ok(!parked.git.calls.some((call) => call.startsWith("removeWorktree")), "its terminals and work are still in there");
});

test("keeping the checkout is a setting, and a removal that fails is reported rather than retried", async () => {
  const kept = fixture({ settings: { keep: true } });
  const workspace = await kept.provider.prepare(REQUEST);
  // The reason travels with the path: "you asked me to keep it" and "I could
  // not delete it" are different things to tell the user.
  assert.deepEqual(await kept.provider.release(workspace, "drained"), { path: workspace.root, reason: "kept-by-setting" });
  assert.ok(!kept.git.calls.some((call) => call.startsWith("removeWorktree")));

  // Routine on Windows: a shell whose current directory is inside the checkout
  // holds it open for as long as it takes to notice it was killed.
  const stuck = fixture({ git: { removeFails: true } });
  const held = await stuck.provider.prepare(REQUEST);
  assert.deepEqual(await stuck.provider.release(held, "drained"), { path: held.root, reason: "removal-failed" });
});

test("cleanup uses the run's frozen keep behavior instead of live settings", async () => {
  const context = fixture();
  const workspace = await context.provider.prepare({
    ...REQUEST,
    worktree: { ...ENABLED, keep: false },
  });
  context.settings.keep = true;
  assert.equal(await context.provider.release(workspace, "drained"), undefined);
  assert.ok(context.git.calls.includes(`removeWorktree ${workspace.root} --force`));
});

test("an in-place run's release never touches anything", async () => {
  const { provider, git } = fixture({ settings: { enabled: false } });
  const workspace = await provider.prepare(REQUEST);
  assert.equal(await provider.release(workspace, "drained"), undefined);
  assert.deepEqual(git.calls, []);
});

test("recorded checkout removal requires a registered clean checkout", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT });
  const clean = fixture({ git: { worktrees: [{ path, branch: "run/test" }] } });
  assert.equal(await clean.provider.removeRecorded(path), true);
  assert.ok(clean.git.calls.includes(`removeWorktree ${path} --force`));
  assert.deepEqual(clean.removed, [path], "record cleanup never targets the checkout's parent directory");

  const dirty = fixture({ git: { worktrees: [{ path, branch: "run/test" }], dirty: ["src/a.ts"] } });
  assert.equal(await dirty.provider.removeRecorded(path), false);
  assert.equal(dirty.git.calls.some((call) => call.startsWith("removeWorktree")), false);

  const missing = fixture();
  assert.equal(await missing.provider.removeRecorded(path), false);
});
