import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  RunWorkspaceError,
  WorktreeRunWorkspaces,
  hasSetupCommands,
  isolationDenyRules,
  overlayProjectConfiguration,
  runWorkspacePath,
  setupCommandLine,
  setupCommandPath,
  type RunWorkspaceDirectories,
  type SetupCommandRequest,
} from "../src/auto/worktree.js";
import type { WorktreeSettings } from "../src/domain/auto-run.js";
import type { GitClient, GitStatus, GitWorktree } from "../src/git/client.js";

const PROJECT = resolve("C:/work/aboard");
const ENABLED: WorktreeSettings = { enabled: true, root: "", keep: false, setupTimeoutSeconds: 600 };

test("a run's checkout is a sibling of the project, named after the repository", () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_abc123" });
  assert.equal(dirname(dirname(path)), join(dirname(PROJECT), ".aboard-sessions"));
  // The leaf is the repository's own name: from inside, the checkout looks like
  // an ordinary clone rather than something an agent should reason about.
  assert.equal(basename(path), basename(PROJECT));
  assert.ok(!path.toLowerCase().includes("worktree"), `${path} must not announce what it is`);
  // Derived from the run id alone, so a resumed run finds the same directory
  // without the record having to carry a copy of the path.
  assert.equal(path, runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_abc123" }));
  assert.notEqual(path, runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_def456" }));
});

test("a configured root is honoured, and one inside the project is refused", () => {
  const custom = runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_abc123", root: resolve("D:/checkouts") });
  assert.equal(custom, join(resolve("D:/checkouts"), "run_abc123", basename(PROJECT)));
  // A relative root resolves against the project, which is exactly how a user
  // writes "next to it" — and how they could accidentally write "inside it".
  assert.equal(
    runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_abc123", root: "../elsewhere" }),
    join(resolve(PROJECT, "../elsewhere"), "run_abc123", basename(PROJECT)),
  );
  for (const inside of [".aboard/checkouts", "build", "."]) {
    assert.throws(
      () => runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_abc123", root: inside }),
      RunWorkspaceError,
      `${inside} is inside the project and must be refused`,
    );
  }
});

test("isolation deny rules fence the file tools out of the user's checkout", () => {
  // `//absolute` is the spelling Read and Edit rules use, with the separators a
  // rule can carry rather than Windows' own.
  const absolute = PROJECT.replaceAll("\\", "/");
  assert.deepEqual(isolationDenyRules(PROJECT), [`Read(//${absolute}/**)`, `Edit(//${absolute}/**)`]);
  // The rules travel as one comma-separated `--disallowedTools` value, so a rule
  // containing a comma would arrive split in half and deny something else.
  assert.deepEqual(isolationDenyRules(resolve("a,b")), []);
});

test("an untouched setup file asks for nothing", () => {
  assert.equal(hasSetupCommands(""), false);
  assert.equal(hasSetupCommands("# only a comment\n\n#   and another\n"), false);
  assert.equal(hasSetupCommands("<#\nnpm ci\n#>\n"), false, "a PowerShell block comment is not a command");
  assert.equal(hasSetupCommands("# comment\nnpm ci\n"), true);
  assert.equal(hasSetupCommands("<# one line #>\nnpm ci\n"), true);
});

test("the setup file and its interpreter follow the platform", () => {
  assert.equal(setupCommandPath("win32"), ".aboard/session-setup.ps1");
  assert.equal(setupCommandPath("linux"), ".aboard/session-setup.sh");
  assert.deepEqual(setupCommandLine("C:/p/.aboard/session-setup.ps1", "win32"), {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/p/.aboard/session-setup.ps1"],
  });
  assert.deepEqual(setupCommandLine("/p/.aboard/session-setup.sh", "darwin"), { command: "bash", args: ["/p/.aboard/session-setup.sh"] });
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
  const branches = new Set(options.branches ?? []);
  const client = {
    currentBranch: async () => "main",
    defaultBranch: async () => "main",
    status: async (): Promise<GitStatus> => ({
      branch: "aboard/run/test",
      entries: (options.dirty ?? []).map((path) => ({ status: "??", path })),
    }),
    codebase: async () => ({ sourceFileCount: 1, languages: ["ts"], commitCount: 1 }),
    headSha: async () => "abc1234",
    branchExists: async (branch: string) => branches.has(branch),
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
    hasCommitFor: async () => false,
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
    },
    // The SHA-aware surface belongs to recovery and cleanup, not to workspaces.
    branchSha: async () => undefined,
    remoteBranchSha: async () => undefined,
    commitDetails: async () => undefined,
    stagedTreeSha: async () => "tree000000000000000000000000000000000000",
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
  readonly overlays: string[];
}

function fixture(options: {
  readonly settings?: Partial<WorktreeSettings>;
  readonly git?: FakeGitOptions;
  readonly setupFile?: string;
  readonly setupFails?: boolean;
  readonly existingDirectories?: readonly string[];
} = {}): Fixture {
  const git = fakeGit(options.git);
  const notifications: string[] = [];
  const setups: SetupCommandRequest[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const overlays: string[] = [];
  const present = new Set(options.existingDirectories ?? []);
  const directories: RunWorkspaceDirectories = {
    exists: async (path) => present.has(path),
    create: async (path) => { created.push(path); present.add(path); },
    remove: async (path) => { removed.push(path); present.delete(path); },
  };
  const provider = new WorktreeRunWorkspaces({
    workspaceRoot: PROJECT,
    git: git.client,
    gitFor: () => git.client,
    settings: () => ({ ...ENABLED, ...options.settings }),
    notify: (message) => notifications.push(message),
    platform: "win32",
    directories,
    readSetupFile: async () => options.setupFile,
    overlayProjectConfiguration: async (request) => { overlays.push(request.worktreeRoot); },
    setup: {
      run: async (request) => {
        setups.push(request);
        if (options.setupFails === true) throw new Error("npm ci failed");
      },
    },
  });
  return { provider, git, notifications, setups, created, removed, overlays };
}

const REQUEST = { runId: "run_test", sessionBranch: "aboard/run/test", base: "main" } as const;

test("worktree mode off leaves the run in the user's own checkout", async () => {
  const { provider, git } = fixture({ settings: { enabled: false } });
  const workspace = await provider.prepare(REQUEST);
  assert.equal(workspace.isolated, false);
  assert.equal(workspace.root, PROJECT);
  assert.deepEqual(workspace.denyTools, [], "an in-place run has nothing to fence itself out of");
  assert.deepEqual(git.calls, [], "no checkout is created, and git is not asked about one");
});

test("preparing a checkout creates it from the remote base and installs into it", async () => {
  const { provider, git, setups, notifications } = fixture({ setupFile: "npm ci\n" });
  const workspace = await provider.prepare(REQUEST);
  const path = runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_test" });
  assert.equal(workspace.root, path);
  assert.equal(workspace.isolated, true);
  assert.deepEqual(workspace.denyTools, isolationDenyRules(PROJECT));
  assert.ok(git.calls.includes(`addWorktree ${path} aboard/run/test origin/main`), git.calls.join(", "));
  // The setup command runs in the new checkout, from the project's own copy of
  // the file — the one the user edits, not whatever the branch carries.
  assert.equal(setups.length, 1);
  assert.equal(setups[0]?.cwd, path);
  assert.equal(setups[0]?.args.at(-1), join(PROJECT, ".aboard", "session-setup.ps1"));
  assert.equal(setups[0]?.env.ABOARD_PROJECT_ROOT, PROJECT);
  assert.equal(setups[0]?.env.ABOARD_SESSION_BRANCH, "aboard/run/test");
  assert.ok(notifications.some((message) => message.includes(path)));
});

test("an existing session branch is checked out rather than created a second time", async () => {
  const { provider, git } = fixture({ git: { branches: ["aboard/run/test"] } });
  await provider.prepare(REQUEST);
  const path = runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_test" });
  assert.ok(git.calls.includes("trackedPathsUnder aboard/run/test .aboard/runtime"), git.calls.join(", "));
  assert.ok(git.calls.includes(`addWorktree ${path} aboard/run/test`), git.calls.join(", "));
});

test("a resumed run re-attaches to its checkout without setting it up again", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_test" });
  const { provider, git, setups } = fixture({
    setupFile: "npm ci\n",
    // Spelled as git reports it on Windows, which is not how Node spells it.
    git: { worktrees: [{ path: path.split(sep).join("/"), branch: "aboard/run/test" }] },
    // A resumed run's checkout legitimately holds an implementer's work.
    ...{},
  });
  const workspace = await provider.prepare(REQUEST);
  assert.equal(workspace.root, path);
  assert.equal(setups.length, 0, "installing again would undo work in flight");
  assert.ok(!git.calls.some((call) => call.startsWith("addWorktree")), git.calls.join(", "));
});

test("a failing setup command refuses the run rather than starting agents in a half-installed tree", async () => {
  const { provider } = fixture({ setupFile: "npm ci\n", setupFails: true });
  await assert.rejects(provider.prepare(REQUEST), (error: unknown) => {
    assert.ok(error instanceof RunWorkspaceError);
    assert.match(error.message, /session-setup\.ps1 failed/u);
    return true;
  });
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

test("untracked aboard hooks are supplied by the project configuration overlay", async () => {
  const { provider, git, overlays } = fixture();
  const workspace = await provider.prepare(REQUEST);
  assert.ok(git.calls.some((call) => call.startsWith("addWorktree")));
  assert.deepEqual(overlays, [workspace.root]);
});

test("tracked runtime state refuses a new checkout at its exact start point before creation", async () => {
  const trackedRuntime = Array.from({ length: 25 }, (_, index) => `.aboard/runtime/file-${index + 1}.json`);
  trackedRuntime[0] = ".aboard/runtime/.gitkeep";
  const { provider, git, overlays } = fixture({ git: { trackedRuntime } });
  await assert.rejects(provider.prepare(REQUEST), (error: unknown) => {
    assert.ok(error instanceof RunWorkspaceError);
    assert.match(error.message, /origin\/main tracks 25 path/u);
    assert.match(error.message, /\.gitkeep/u, "even an empty keeper is tracked runtime state");
    assert.match(error.message, /git rm -r --cached/u);
    assert.doesNotMatch(error.message, /file-21\.json/u, "the diagnostic is bounded");
    return true;
  });
  assert.ok(git.calls.includes("trackedPathsUnder origin/main .aboard/runtime"), git.calls.join(", "));
  assert.ok(!git.calls.some((call) => call.startsWith("addWorktree")), "the unsafe checkout is never created");
  assert.deepEqual(overlays, [], "no source configuration is read after the preflight fails");
});

test("a resumed checkout refuses runtime state tracked at its own HEAD", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_test" });
  const { provider, git } = fixture({
    git: {
      trackedRuntime: [".aboard/runtime/session.json"],
      worktrees: [{ path, branch: "aboard/run/test" }],
    },
  });
  await assert.rejects(provider.prepare(REQUEST), /HEAD tracks 1 path/u);
  assert.ok(git.calls.includes("trackedPathsUnder HEAD .aboard/runtime"), git.calls.join(", "));
});

test("the project overlay copies ignored Claude and aboard files, preserves checkout files, and is a one-time snapshot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-overlay-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  const checkout = join(root, "checkout");
  await mkdir(join(project, ".claude", "hooks"), { recursive: true });
  await mkdir(join(project, ".claude", "skills", "local"), { recursive: true });
  await mkdir(join(project, ".claude", "worktrees", "other"), { recursive: true });
  await mkdir(join(project, ".aboard", "agents"), { recursive: true });
  await mkdir(join(project, ".aboard", "runtime", "events"), { recursive: true });
  await mkdir(join(project, ".aboard", "prototypes", "7-parser"), { recursive: true });
  await mkdir(join(checkout, ".claude"), { recursive: true });
  await mkdir(join(checkout, ".aboard"), { recursive: true });
  await mkdir(join(checkout, ".aboard", "runtime"), { recursive: true });
  await writeFile(join(project, ".claude", "settings.json"), "from project\n");
  await writeFile(join(project, ".claude", "settings.local.json"), "local settings\n");
  await writeFile(join(project, ".claude", "hooks", "aboard_hook.py"), "hook\n");
  await writeFile(join(project, ".claude", "skills", "local", "SKILL.md"), "skill\n");
  await writeFile(join(project, ".claude", "worktrees", "other", "secret"), "transient\n");
  await writeFile(join(project, ".aboard", "scaffold.json"), "scaffold\n");
  await writeFile(join(project, ".aboard", "agents", "manager.md"), "manager\n");
  await writeFile(join(project, ".aboard", "session-setup.ps1"), "from project\n");
  await writeFile(join(project, ".aboard", "settings.json"), "local aboard settings\n");
  await writeFile(join(project, ".aboard", "runtime", "events", "secret.json"), "runtime\n");
  await writeFile(join(project, ".aboard", "prototypes", "7-parser", "experiment.ts"), "scratch\n");
  await writeFile(join(checkout, ".claude", "settings.json"), "from git\n");
  await writeFile(join(checkout, ".aboard", "session-setup.ps1"), "from git\n");
  const requested: string[] = [];
  const git = {
    ignoredPaths: async (paths: readonly string[]) => { requested.push(...paths); return paths; },
  } as Pick<GitClient, "ignoredPaths"> as GitClient;

  await overlayProjectConfiguration({ workspaceRoot: project, worktreeRoot: checkout, git });
  assert.equal(await readFile(join(checkout, ".claude", "settings.json"), "utf8"), "from git\n");
  assert.equal(await readFile(join(checkout, ".claude", "settings.local.json"), "utf8"), "local settings\n");
  assert.equal(await readFile(join(checkout, ".claude", "hooks", "aboard_hook.py"), "utf8"), "hook\n");
  assert.equal(await readFile(join(checkout, ".claude", "skills", "local", "SKILL.md"), "utf8"), "skill\n");
  assert.equal(await readFile(join(checkout, ".aboard", "scaffold.json"), "utf8"), "scaffold\n");
  assert.equal(await readFile(join(checkout, ".aboard", "agents", "manager.md"), "utf8"), "manager\n");
  assert.equal(await readFile(join(checkout, ".aboard", "settings.json"), "utf8"), "local aboard settings\n");
  assert.equal(await readFile(join(checkout, ".aboard", "session-setup.ps1"), "utf8"), "from git\n");
  assert.ok(requested.includes(".claude/settings.local.json"), "settings.local.json is deliberately copied");
  await assert.rejects(readFile(join(checkout, ".claude", "worktrees", "other", "secret")), { code: "ENOENT" });
  await assert.rejects(readFile(join(checkout, ".aboard", "runtime", "events", "secret.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(checkout, ".aboard", "prototypes", "7-parser", "experiment.ts")), { code: "ENOENT" });

  await writeFile(join(project, ".claude", "settings.local.json"), "changed later\n");
  await writeFile(join(project, ".claude", "new-after-creation.md"), "later\n");
  await overlayProjectConfiguration({ workspaceRoot: project, worktreeRoot: checkout, git });
  assert.equal(await readFile(join(checkout, ".claude", "settings.local.json"), "utf8"), "local settings\n");
  await assert.rejects(readFile(join(checkout, ".claude", "new-after-creation.md")), { code: "ENOENT" });
});

test("the project overlay refuses unignored local configuration before copying any of it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-overlay-ignore-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  const checkout = join(root, "checkout");
  await mkdir(join(project, ".claude"), { recursive: true });
  await mkdir(join(project, ".aboard"), { recursive: true });
  await mkdir(join(checkout, ".aboard", "runtime"), { recursive: true });
  await writeFile(join(project, ".claude", "settings.local.json"), "local settings\n");
  const git = { ignoredPaths: async () => [] } as Pick<GitClient, "ignoredPaths"> as GitClient;
  await assert.rejects(
    overlayProjectConfiguration({ workspaceRoot: project, worktreeRoot: checkout, git }),
    /git does not ignore.*settings\.local\.json/u,
  );
  await assert.rejects(readFile(join(checkout, ".claude", "settings.local.json")), { code: "ENOENT" });
});

test("the project overlay never follows a missing symbolic link", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-overlay-link-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  const checkout = join(root, "checkout");
  await mkdir(join(project, ".claude"), { recursive: true });
  await mkdir(join(project, ".aboard"), { recursive: true });
  await mkdir(join(checkout, ".aboard", "runtime"), { recursive: true });
  const outside = join(root, "outside.json");
  await writeFile(outside, "secret\n");
  try {
    await symlink(outside, join(project, ".claude", "linked.json"), "file");
  } catch (error) {
    if (process.platform === "win32" && typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
      context.skip("creating symlinks requires Windows Developer Mode");
      return;
    }
    throw error;
  }
  const git = { ignoredPaths: async (paths: readonly string[]) => paths } as Pick<GitClient, "ignoredPaths"> as GitClient;
  await assert.rejects(
    overlayProjectConfiguration({ workspaceRoot: project, worktreeRoot: checkout, git }),
    /symbolic link or junction/u,
  );
  await assert.rejects(readFile(join(checkout, ".claude", "linked.json")), { code: "ENOENT" });
});

test("a directory in the way is reported rather than checked out over", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_test" });
  const { provider } = fixture({ existingDirectories: [path] });
  await assert.rejects(provider.prepare(REQUEST), RunWorkspaceError);
});

test("a drained run's checkout is removed; an interrupted one is left where the user was sent", async () => {
  const drained = fixture();
  const workspace = await drained.provider.prepare(REQUEST);
  assert.equal(await drained.provider.release(workspace, "drained"), undefined);
  assert.ok(drained.git.calls.includes(`removeWorktree ${workspace.root} --force`));
  assert.deepEqual(drained.removed, [dirname(workspace.root)], "the per-run directory goes with the checkout");

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

test("an in-place run's release never touches anything", async () => {
  const { provider, git } = fixture({ settings: { enabled: false } });
  const workspace = await provider.prepare(REQUEST);
  assert.equal(await provider.release(workspace, "drained"), undefined);
  assert.deepEqual(git.calls, []);
});

test("recorded checkout removal requires a registered clean checkout", async () => {
  const path = runWorkspacePath({ workspaceRoot: PROJECT, runId: "run_test" });
  const clean = fixture({ git: { worktrees: [{ path, branch: "aboard/run/test" }] } });
  assert.equal(await clean.provider.removeRecorded(path), true);
  assert.ok(clean.git.calls.includes(`removeWorktree ${path} --force`));

  const dirty = fixture({ git: { worktrees: [{ path, branch: "aboard/run/test" }], dirty: ["src/a.ts"] } });
  assert.equal(await dirty.provider.removeRecorded(path), false);
  assert.equal(dirty.git.calls.some((call) => call.startsWith("removeWorktree")), false);

  const missing = fixture();
  assert.equal(await missing.provider.removeRecorded(path), false);
});
