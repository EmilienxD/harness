import assert from "node:assert/strict";
import test from "node:test";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  REQUIRED_TRACKED_PATHS,
  RunWorkspaceError,
  WorktreeRunWorkspaces,
  hasSetupCommands,
  isolationDenyRules,
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
  readonly tracked?: readonly string[];
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
    fastForward: async () => { calls.push("fastForward"); },
    mergeFromRemote: async () => true,
    add: async () => { calls.push("add"); },
    commit: async () => "abc1234",
    push: async () => { calls.push("push"); },
    hasCommitFor: async () => false,
    isPushed: async () => true,
    trackedPaths: async (paths: readonly string[]) => {
      const tracked = new Set(options.tracked ?? REQUIRED_TRACKED_PATHS);
      return paths.filter((path) => tracked.has(path));
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
    setup: {
      run: async (request) => {
        setups.push(request);
        if (options.setupFails === true) throw new Error("npm ci failed");
      },
    },
  });
  return { provider, git, notifications, setups, created, removed };
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

test("uncommitted aboard hooks refuse worktree mode, because a second checkout holds only what git has", async () => {
  const { provider, git } = fixture({ git: { tracked: [".claude/hooks/aboard_hook.py"] } });
  await assert.rejects(provider.prepare(REQUEST), (error: unknown) => {
    assert.ok(error instanceof RunWorkspaceError);
    assert.match(error.message, /\.claude\/settings\.json/u);
    return true;
  });
  assert.ok(!git.calls.some((call) => call.startsWith("addWorktree")), "nothing is created before the refusal");
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
