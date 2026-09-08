import assert from "node:assert/strict";
import test from "node:test";

import { AboardBranchCleanup, describeAboardBranchDiscovery, type AboardBranchDiscovery, type AboardBranchRepository } from "../src/git/branch-cleanup.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function snapshot(): AboardBranchDiscovery {
  return {
    defaultBranch: "main",
    branches: [
      { name: "issue/12-local", localSha: SHA_A, ahead: 1, behind: 2 },
      { name: "run/old", localSha: SHA_B, remoteSha: SHA_B, ahead: 3, behind: 0, checkout: { path: "C:\\old", dirtyPaths: ["src/a.ts"], primary: false } },
    ],
    pullRequests: [{ number: 7, title: "Old run", state: "open", head: "run/old", base: "main" }],
  };
}

test("discovery explains location, history, worktree dirt, and pull requests", () => {
  const detail = describeAboardBranchDiscovery(snapshot());
  assert.match(detail, /issue\/12-local[\s\S]*local only[\s\S]*1 ahead \/ 2 behind main/);
  assert.match(detail, /run\/old[\s\S]*local \+ GitHub, in sync[\s\S]*uncommitted path[\s\S]*src\/a\.ts[\s\S]*#7 open “Old run”/);
});

test("clear uses the discovered SHAs and retains checked-out dirty work", async () => {
  const calls: string[] = [];
  const git: AboardBranchRepository = {
    discover: async () => ({ defaultBranch: "main", branches: snapshot().branches }),
    checkoutDefault: async () => false,
    deleteLocal: async (branch, sha) => { calls.push(`local ${branch} ${sha}`); return true; },
    deleteRemote: async (branch, sha) => { calls.push(`remote ${branch} ${sha}`); return true; },
  };
  const cleanup = new AboardBranchCleanup(git, { listPullRequestsForBranches: async () => snapshot().pullRequests });
  const result = await cleanup.clear(await cleanup.discover());
  assert.deepEqual(calls, [`local issue/12-local ${SHA_A}`, `remote run/old ${SHA_B}`]);
  assert.deepEqual(result.deletedLocal, ["issue/12-local"]);
  assert.deepEqual(result.deletedRemote, ["run/old"]);
  assert.match(result.retained.join("\n"), /checked out at C:\\old/);
});

test("a clean primary checkout is moved to the default branch before deletion", async () => {
  const calls: string[] = [];
  const git: AboardBranchRepository = {
    discover: async () => ({ defaultBranch: "main", branches: [] }),
    checkoutDefault: async (branch, base) => { calls.push(`checkout ${branch} ${base}`); return true; },
    deleteLocal: async (branch, sha) => { calls.push(`delete ${branch} ${sha}`); return true; },
    deleteRemote: async () => true,
  };
  const cleanup = new AboardBranchCleanup(git, { listPullRequestsForBranches: async () => [] });
  await cleanup.clear({ defaultBranch: "main", pullRequests: [], branches: [{ name: "issue/1-x", localSha: SHA_A, ahead: 0, behind: 0, checkout: { path: "C:\\repo", dirtyPaths: [], primary: true } }] });
  assert.deepEqual(calls, [`checkout issue/1-x main`, `delete issue/1-x ${SHA_A}`]);
});
