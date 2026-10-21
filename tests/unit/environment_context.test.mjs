import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register, { collectGitStatus } from "../../harness/productivity/environment-context/pi/extension.ts";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "environment-context-unit-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "", GIT_TERMINAL_PROMPT: "0" },
  });
  return { cwd, git, write: (name, text = "original\n") => writeFileSync(join(cwd, name), text) };
}

function init(f) {
  f.git("init", "--quiet");
  f.git("config", "user.name", "Fixture");
  f.git("config", "user.email", "fixture@example.invalid");
  f.git("config", "core.autocrlf", "false");
  f.git("config", "commit.gpgsign", "false");
}

const emptyCounts = { total: 0, modified: 0, added: 0, deleted: 0, renamed: 0, copied: 0, untracked: 0, conflicted: 0, staged: 0, unstaged: 0 };

test("non-Git directories and unavailable directories are distinct", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await collectGitStatus(f.cwd), { kind: "missing" });
  assert.deepEqual(await collectGitStatus(join(f.cwd, "does-not-exist")), { kind: "unavailable" });
});

test("clean and unborn repositories have zero counts", async (t) => {
  const f = fixture(t); init(f);
  let status = await collectGitStatus(f.cwd);
  assert.equal(status.kind, "repository");
  assert.deepEqual(status.counts, emptyCounts);
  assert.equal(status.truncated, false);
  f.write("tracked.txt"); f.git("add", "."); f.git("commit", "--quiet", "-m", "fixture");
  status = await collectGitStatus(f.cwd);
  assert.deepEqual(status.counts, emptyCounts);
  assert.deepEqual(status.files, []);
});

test("full counts survive truncation, including individually counted untracked files", async (t) => {
  const f = fixture(t); init(f);
  for (const name of ["modified.txt", "deleted.txt", "rename.txt"]) f.write(name);
  f.git("add", "."); f.git("commit", "--quiet", "-m", "fixture");
  f.write("modified.txt", "staged\n"); f.git("add", "modified.txt"); f.write("modified.txt", "unstaged\n");
  unlinkSync(join(f.cwd, "deleted.txt")); f.git("mv", "rename.txt", "renamed.txt");
  f.write("added.txt"); f.git("add", "added.txt");
  mkdirSync(join(f.cwd, "untracked"));
  for (let i = 0; i < 1000; i++) f.write(`untracked/new-${String(i).padStart(4, "0")}.txt`);
  const status = await collectGitStatus(f.cwd);
  assert.equal(status.kind, "repository");
  assert.deepEqual(status.counts, { total: 1004, modified: 1, added: 1, deleted: 1, renamed: 1, copied: 0, untracked: 1000, conflicted: 0, staged: 3, unstaged: 2 });
  assert.equal(status.files.length, 12);
  assert.equal(status.truncated, true);
  // A GitHub remote is deliberately absent; ordinary local repositories count too.
  assert.equal(f.git("remote").trim(), "");
});

test("long paths trigger the character bound before the file-count bound", async (t) => {
  const f = fixture(t); init(f);
  const segment = "a".repeat(50);
  mkdirSync(join(f.cwd, segment));
  for (let i = 0; i < 12; i++) f.write(`${segment}/${"b".repeat(70)}-${i}.txt`);
  const status = await collectGitStatus(f.cwd);
  assert.equal(status.counts.untracked, 12);
  assert.equal(status.files.length, 12);
  assert.equal(status.truncated, true);
});

test("conflicts are counted once, not as ordinary modifications", async (t) => {
  const f = fixture(t); init(f);
  f.write("conflict.txt"); f.git("add", "."); f.git("commit", "--quiet", "-m", "base");
  const branch = f.git("branch", "--show-current").trim();
  f.git("checkout", "--quiet", "-b", "other"); f.write("conflict.txt", "other\n"); f.git("commit", "--quiet", "-am", "other");
  f.git("checkout", "--quiet", branch); f.write("conflict.txt", "main\n"); f.git("commit", "--quiet", "-am", "main");
  assert.throws(() => f.git("merge", "other"));
  const status = await collectGitStatus(f.cwd);
  assert.deepEqual(status.counts, { ...emptyCounts, total: 1, conflicted: 1 });
});

test("section ownership leaves cwd and other extensions intact across lifecycle events", async (t) => {
  const f = fixture(t);
  const handlers = new Map();
  register({ on: (name, handler) => handlers.set(name, handler) });
  assert.deepEqual([...handlers.keys()], ["session_start", "before_agent_start"]);
  let headerReads = 0;
  const ctx = { cwd: f.cwd, sessionManager: { getHeader: () => {
    headerReads++;
    return { timestamp: "2026-01-02T03:04:05.000Z" };
  } } };
  for (const reason of ["startup", "reload", "resume", "new", "fork"]) {
    await handlers.get("session_start")({ reason }, ctx);
    const existing = {};
    const sections = { cwd: existing, another_extension: existing };
    await handlers.get("before_agent_start")({ systemPromptOptions: { sections } }, ctx);
    assert.deepEqual(Object.keys(sections).sort(), ["another_extension", "cwd", "environment", "git_snapshot"]);
    assert.equal(sections.cwd, existing);
    assert.equal(sections.another_extension, existing);
    assert.equal(typeof sections.environment, "string");
    assert.equal(typeof sections.git_snapshot, "string");
    assert(sections.git_snapshot.length < 2200);
  }
  assert.equal(headerReads, 5);
});
