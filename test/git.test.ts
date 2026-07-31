import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ProcessGitClient, dirtyPaths, isWorkingTreeClean } from "../src/git/client.js";

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

test("a failing git command raises a typed boundary error carrying stderr", async () => {
  const root = await repository();
  const client = new ProcessGitClient(root);
  await assert.rejects(client.checkout("does-not-exist"), (error: unknown) => {
    assert.equal((error as { name: string }).name, "GitBoundaryError");
    assert.equal((error as { code: string }).code, "command-failed");
    return true;
  });
});
