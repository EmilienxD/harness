import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ProcessGitClient, dirtyPaths, isWorkingTreeClean, summarizeSourceFiles } from "../src/git/client.js";

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

/**
 * A remote-tracking ref without a remote. `git merge origin/main` reads the ref
 * and nothing else, so the boundary can be exercised against real git without a
 * network or a second clone.
 */
async function trackRemote(root: string, branch: string): Promise<void> {
  await run("git", ["update-ref", `refs/remotes/origin/${branch}`, branch], { cwd: root, windowsHide: true });
}

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
