import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { CachingGitClient, ProcessGitClient, dirtyPaths, isWorkingTreeClean, summarizeSourceFiles, type GitClient } from "../src/git/client.js";

const run = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aboard-git-"));
  const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  await git("init", "--initial-branch", "main");
  await git("config", "user.email", "aboard@example.test");
  await git("config", "user.name", "aboard test");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "README.md"), "start\n");
  await git("add", "-A");
  await git("commit", "-m", "initial");
  return root;
}

test("the git boundary reports branch, status, and branch existence", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  assert.equal(await client.currentBranch(), "main");
  assert.equal(await client.defaultBranch(), "main");
  assert.equal(isWorkingTreeClean(await client.status()), true);

  await writeFile(join(root, "src.ts"), "export const a = 1;\n");
  const dirty = await client.status();
  assert.equal(isWorkingTreeClean(dirty), false);
  assert.deepEqual(dirtyPaths(dirty), ["src.ts"]);

  assert.equal(await client.branchExists("main"), true);
  assert.equal(await client.branchExists("aboard/34-nothing"), false);
});

test("createBranch, add, and commit leave the branch carrying the issue's commit", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  await client.createBranch("aboard/34-add-retry-backoff", "main");
  assert.equal(await client.currentBranch(), "aboard/34-add-retry-backoff");

  await writeFile(join(root, "src.ts"), "export const a = 1;\n");
  await client.add();
  const sha = await client.commit("Add retry backoff", "Implements #34.");
  assert.match(sha, /^[0-9a-f]{7,}$/);
  assert.equal(isWorkingTreeClean(await client.status()), true);

  // Only commits this branch adds over its base count, and the issue number is
  // matched as a whole reference.
  assert.equal(await client.hasCommitFor(34, "main"), true);
  assert.equal(await client.hasCommitFor(3, "main"), false);
  assert.equal(await client.hasCommitFor(340, "main"), false);
  await client.checkout("main");
  assert.equal(await client.hasCommitFor(34, "main"), false);
});

test("deleteBranch removes only a fully merged local branch", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  await client.createBranch("aboard/34-no-change", "main");
  await client.checkout("main");
  await client.deleteBranch("aboard/34-no-change");
  assert.equal(await client.branchExists("aboard/34-no-change"), false);

  await client.createBranch("aboard/35-has-work", "main");
  await writeFile(join(root, "src.ts"), "export const changed = true;\n");
  await client.add();
  await client.commit("Unexpected work", "");
  await client.checkout("main");
  await assert.rejects(client.deleteBranch("aboard/35-has-work"));
  assert.equal(await client.branchExists("aboard/35-has-work"), true);
});

async function trackRemote(root: string, branch: string, at: string = branch): Promise<void> {
  await run("git", ["update-ref", `refs/remotes/origin/${branch}`, at], { cwd: root, windowsHide: true });
}

test("remote branch existence is a separate question from being pushed", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  assert.equal(await client.remoteBranchExists("main"), false);

  await trackRemote(root, "main");
  assert.equal(await client.remoteBranchExists("main"), true);
  assert.equal(await client.isPushed("main"), true);

  // A local commit the remote has not seen: still there, no longer in sync. A
  // pull request base cares about the first, the commit phase about the second.
  await writeFile(join(root, "NOTES.md"), "moved on\n");
  await client.add();
  await client.commit("Move on", "");
  assert.equal(await client.remoteBranchExists("main"), true);
  assert.equal(await client.isPushed("main"), false);
  assert.equal(await client.remoteBranchExists("aboard/run/nothing"), false);
});

test("mergeFromRemote brings the branch up to date with its base", async () => {
  const root = await repository();
  const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  const client = new ProcessGitClient(root);

  await client.createBranch("aboard/34-add-retry-backoff", "main");
  await writeFile(join(root, "src.ts"), "export const a = 1;\n");
  await client.add();
  await client.commit("Add retry backoff", "Implements #34.");

  await client.checkout("main");
  await writeFile(join(root, "NOTES.md"), "moved on\n");
  await client.add();
  await client.commit("Move on", "");
  await trackRemote(root, "main");

  await client.checkout("aboard/34-add-retry-backoff");
  assert.equal(await client.mergeFromRemote("main"), true);
  assert.equal(isWorkingTreeClean(await client.status()), true);
  assert.match((await git("log", "--format=%s")).stdout, /Move on/);
});

test("a conflicting mergeFromRemote reports false and puts the tree back", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);

  await client.createBranch("aboard/34-add-retry-backoff", "main");
  await writeFile(join(root, "README.md"), "branch\n");
  await client.add();
  await client.commit("Rewrite the readme", "Implements #34.");

  await client.checkout("main");
  await writeFile(join(root, "README.md"), "trunk\n");
  await client.add();
  await client.commit("Rewrite it differently", "");
  await trackRemote(root, "main");

  await client.checkout("aboard/34-add-retry-backoff");
  assert.equal(await client.mergeFromRemote("main"), false);
  // Aborted, not abandoned half-merged: no conflict markers, nothing staged.
  assert.equal(isWorkingTreeClean(await client.status()), true);
  // Trimmed: `core.autocrlf` rewrites the line ending on checkout under Windows.
  assert.equal((await readFile(join(root, "README.md"), "utf8")).trim(), "branch");
});

test("a failing git command raises a typed boundary error carrying stderr", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  await assert.rejects(client.checkout("does-not-exist"), (error: unknown) => {
    assert.equal((error as { name: string }).name, "GitBoundaryError");
    assert.equal((error as { code: string }).code, "command-failed");
    return true;
  });
});

test("summarizing source files separates code from everything a project is merely described in", () => {
  const summary = summarizeSourceFiles([
    "README.md", "LICENSE", "package.json", ".gitignore", "docs/design.md", "data/rows.csv",
    "src/a.ts", "src/b.ts", "src/c.tsx", "scripts/run.py", "Makefile", "src/no-extension.",
  ]);
  // A README, a licence, and a manifest describe a project without being one.
  assert.equal(summary.sourceFileCount, 4);
  // Most files first, so the label reads as the project's language.
  assert.deepEqual(summary.languages, ["ts", "py", "tsx"]);
  assert.deepEqual(summarizeSourceFiles(["README.md"]), { sourceFileCount: 0, languages: [] });
});

test("the codebase survey sees uncommitted work, ignores gitignored trees, and counts commits", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);

  // A README and one commit: the repository exists, the project does not.
  const bare = await client.codebase();
  assert.equal(bare.sourceFileCount, 0);
  assert.equal(bare.commitCount, 1);

  await writeFile(join(root, ".gitignore"), "vendor/\n");
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "vendor/huge.ts"), "export const vendored = 1;\n");
  // Never committed, which is exactly what a project's first hours look like.
  await writeFile(join(root, "app.ts"), "export const a = 1;\n");

  const survey = await client.codebase();
  assert.equal(survey.sourceFileCount, 1);
  assert.deepEqual(survey.languages, ["ts"]);
  assert.equal(survey.commitCount, 1);
});

test("an unborn branch surveys as no code and no commits rather than failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-git-"));
  await run("git", ["init", "--initial-branch", "main"], { cwd: root, windowsHide: true });
  const survey = await new ProcessGitClient(root).codebase();
  assert.deepEqual(survey, { sourceFileCount: 0, languages: [], commitCount: 0 });
});

test("the git boundary creates, lists, and removes a checkout beside the repository", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  const checkout = join(await mkdtemp(join(tmpdir(), "aboard-sessions-")), "repo");

  await client.addWorktree(checkout, "aboard/run/test", "main");
  const listed = await client.worktrees();
  assert.equal(listed.length, 2, JSON.stringify(listed));
  // Git prints its own spelling of the path, so a caller compares resolved
  // paths rather than strings; what matters here is the branch it reports.
  assert.equal(listed.some((worktree) => worktree.branch === "aboard/run/test"), true, JSON.stringify(listed));
  // The branch is real and the checkout works on its own: a client bound there
  // sees it as the current branch while the repository stays on main.
  assert.equal(await client.branchExists("aboard/run/test"), true);
  assert.equal(await new ProcessGitClient(checkout).currentBranch(), "aboard/run/test");
  assert.equal(await client.currentBranch(), "main");

  await client.removeWorktree(checkout, true);
  assert.equal((await client.worktrees()).length, 1);
});

test("ignored paths identify local configuration that git add cannot stage", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  await writeFile(join(root, ".gitignore"), ".claude/settings.local.json\n.claude/private/\n");
  assert.deepEqual(
    await client.ignoredPaths([
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/private/skill.md",
    ]),
    [".claude/settings.local.json", ".claude/private/skill.md"],
  );
});

test("tracked paths under a directory are read from the requested tree without reading contents", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  await mkdir(join(root, ".aboard", "runtime"), { recursive: true });
  await writeFile(join(root, ".aboard", "runtime", ".gitkeep"), "");
  await writeFile(join(root, ".aboard", "runtime", "session.json"), "private\n");
  await run("git", ["add", "-f", ".aboard/runtime"], { cwd: root, windowsHide: true });
  await run("git", ["commit", "-m", "bad runtime"], { cwd: root, windowsHide: true });
  assert.deepEqual(
    await client.trackedPathsUnder("HEAD", ".aboard/runtime"),
    [".aboard/runtime/.gitkeep", ".aboard/runtime/session.json"],
  );
});

test("full SHAs answer for local and remote refs, and for neither when absent", async () => {
  const root = await repository();
  const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  const client = new ProcessGitClient(root);

  const head = await client.branchSha("main");
  // Full rather than abbreviated: recovery compares against a value recorded
  // hours earlier, and an abbreviation that was unambiguous then need not stay so.
  assert.match(head ?? "", /^[0-9a-f]{40}$/);
  assert.equal(head, await client.headSha(false));
  assert.notEqual(head, await client.headSha());

  assert.equal(await client.branchSha("aboard/nothing"), undefined);
  assert.equal(await client.remoteBranchSha("main"), undefined, "nothing has been pushed anywhere");

  // A bare remote makes `origin/main` real without a network.
  const remote = await mkdtemp(join(tmpdir(), "aboard-git-remote-"));
  await run("git", ["init", "--bare", "--initial-branch", "main"], { cwd: remote, windowsHide: true });
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");
  assert.equal(await client.remoteBranchSha("main"), head);
});

test("a commit is recognisable again by its exact parent, message, and tree", async () => {
  const root = await repository();
  const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  const client = new ProcessGitClient(root);
  const parent = await client.headSha(false);

  await writeFile(join(root, "src.ts"), "export const a = 1;\n");
  await client.add();
  const treeSha = await client.stagedTreeSha();
  // A subject with the punctuation an issue title routinely carries.
  await client.commit("Add retry backoff: 2x, with jitter", "Addresses #34.");

  const details = await client.commitDetails("main");
  assert.equal(details?.parents.length, 1);
  assert.equal(details?.parents[0], parent);
  assert.equal(details?.subject, "Add retry backoff: 2x, with jitter");
  assert.equal(details?.message, "Add retry backoff: 2x, with jitter\n\nAddresses #34.");
  assert.equal(details?.treeSha, treeSha);
  assert.equal(details?.sha, await client.headSha(false));
  assert.equal(await client.commitDetails("refs/heads/nothing"), undefined);
});

test("branch deletion is refused unless the ref still points where the run left it", async () => {
  const root = await repository();
  const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  const client = new ProcessGitClient(root);
  await client.createBranch("aboard/34-one", "main");
  await writeFile(join(root, "src.ts"), "export const a = 1;\n");
  await client.add();
  await client.commit("Add retry backoff", "Addresses #34.");
  const recorded = await client.branchSha("aboard/34-one");
  await git("checkout", "main");

  // A ref that moved is no longer a branch this run can prove it created.
  assert.equal(await client.deleteBranchAt("aboard/34-one", "0".repeat(40)), false);
  assert.equal(await client.branchExists("aboard/34-one"), true);
  // Absent entirely is the same answer, not a crash.
  assert.equal(await client.deleteBranchAt("aboard/never-existed", "0".repeat(40)), false);

  // The SHA check, not git's merge heuristic, is what makes this safe: the
  // branch is unmerged, and deleting it is exactly what the user asked for.
  assert.equal(await client.deleteBranchAt("aboard/34-one", recorded!), true);
  assert.equal(await client.branchExists("aboard/34-one"), false);
});

test("remote branch deletion is guarded the same way, over a real remote", async () => {
  const root = await repository();
  const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  const client = new ProcessGitClient(root);
  const remote = await mkdtemp(join(tmpdir(), "aboard-git-remote-"));
  await run("git", ["init", "--bare", "--initial-branch", "main"], { cwd: remote, windowsHide: true });
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");

  await client.createBranch("aboard/34-one", "main");
  await writeFile(join(root, "src.ts"), "export const a = 1;\n");
  await client.add();
  await client.commit("Add retry backoff", "Addresses #34.");
  await client.push("aboard/34-one", true);
  const recorded = await client.remoteBranchSha("aboard/34-one");
  assert.match(recorded ?? "", /^[0-9a-f]{40}$/);

  assert.equal(await client.deleteRemoteBranchAt("aboard/34-one", "0".repeat(40)), false);
  assert.equal(await client.remoteBranchExists("aboard/34-one"), true);

  assert.equal(await client.deleteRemoteBranchAt("aboard/34-one", recorded!), true);
  await client.fetch();
  assert.equal(await client.remoteBranchExists("aboard/34-one"), false);
});

test("existingBranches answers local and remote membership in one read", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  await client.createBranch("aboard/34-local-only", "main");
  await client.checkout("main");
  await client.createBranch("aboard/35-both", "main");
  await client.checkout("main");
  await trackRemote(root, "aboard/35-both");
  await trackRemote(root, "aboard/36-remote-only", "main");

  const found = await client.existingBranches([
    "aboard/34-local-only",
    "aboard/35-both",
    "aboard/36-remote-only",
    "aboard/37-nowhere",
  ]);
  assert.deepEqual([...found.local].sort(), ["aboard/34-local-only", "aboard/35-both"]);
  assert.deepEqual([...found.remote].sort(), ["aboard/35-both", "aboard/36-remote-only"]);

  // An empty ask never reaches git.
  assert.deepEqual(await client.existingBranches([]), { local: new Set(), remote: new Set() });
});

test("the caching git client coalesces fetches and lets a fresh read through", async () => {
  let fetches = 0;
  let clock = 1_000;
  const inner = {
    fetch: async () => { fetches += 1; },
  } as unknown as GitClient;
  const client = new CachingGitClient(inner, 5_000, () => clock);

  await client.fetch();
  await client.fetch();
  await client.fetch();
  assert.equal(fetches, 1, "fetches inside the freshness window share one remote read");

  clock += 6_000;
  await client.fetch();
  assert.equal(fetches, 2, "a fetch past the window reaches the remote again");

  await client.fetch({ fresh: true });
  assert.equal(fetches, 3, "a fresh read bypasses the window it also re-arms");

  await client.fetch();
  assert.equal(fetches, 3, "the fresh read's timestamp serves the next ordinary fetch");
});

test("the caching git client shares one in-flight fetch across overlapping callers", async () => {
  let fetches = 0;
  // The fetch the test controls; reassigned each time the inner client is hit.
  let settle: () => void = () => undefined;
  const inner = {
    fetch: () => {
      fetches += 1;
      return new Promise<void>((resolve) => { settle = resolve; });
    },
  } as unknown as GitClient;
  const client = new CachingGitClient(inner, 5_000);

  // Three callers before the first fetch settles: they join one remote read.
  const joined = Promise.all([client.fetch(), client.fetch(), client.fetch()]);
  assert.equal(fetches, 1, "overlapping fetches start one remote read");
  settle();
  await joined;
  assert.equal(fetches, 1, "overlapping fetches join rather than queue");
});

test("a failed fetch records nothing, so the next caller retries remotely", async () => {
  let fetches = 0;
  let clock = 1_000;
  let failNext = false;
  const inner = {
    fetch: async () => {
      fetches += 1;
      if (failNext) { failNext = false; throw new Error("remote ref lock busy"); }
    },
  } as unknown as GitClient;
  const client = new CachingGitClient(inner, 5_000, () => clock);

  await client.fetch();
  clock += 6_000;
  failNext = true;
  await assert.rejects(client.fetch());
  assert.equal(fetches, 2, "a fetch outside the window reaches the remote");

  await client.fetch();
  assert.equal(fetches, 3, "a failed fetch records nothing, so the retry is a fresh remote read");
});
