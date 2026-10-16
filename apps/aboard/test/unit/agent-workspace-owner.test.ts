import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AgentWorkspaceFiles, WorkspaceRequestJournal, WorkspaceRequestConflictError, acquireWorkspaceOwner, acquireOrdinaryWorkspaceOwner } from "../../src/runtime/agent-workspace-owner.js";
import { normalizeProjectPath } from "../../src/bridge/command-endpoint.js";

test("startup handoff opens the same project under distinct persistent owners", async () => {
  const files = new AgentWorkspaceFiles(await mkdtemp(join(tmpdir(), "aboard-owner-")));
  const first = await files.create(process.cwd(), { empty: true }, "first-request");
  const second = await files.create(process.cwd(), { empty: true }, "second-request");
  assert.notEqual(first.ownerId, second.ownerId);
  assert.equal(basename(first.workspaceFile), `${basename(process.cwd())}.code-workspace`);
  assert.equal(basename(second.workspaceFile), basename(first.workspaceFile));
  assert.notEqual(dirname(first.workspaceFile), dirname(second.workspaceFile));
  assert.deepEqual(await files.read(first.workspaceFile, process.cwd()), first);
  assert.equal(await files.read(first.workspaceFile, join(process.cwd(), "other")), undefined);
  assert.equal(normalizeProjectPath("C:\\Work\\Repo\\..\\Project\\", "win32"), "c:/work/project");
});

test("duplicate deliveries share a result and completed launches are not repeated after reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-request-"));
  const journal = new WorkspaceRequestJournal(root);
  const launched: string[] = [];
  const operation = async () => { launched.push("session"); return { agents: ["session"] }; };
  const results = await Promise.all([journal.execute("request-one", operation), journal.execute("request-one", operation)]);
  assert.deepEqual(results, [{ agents: ["session"] }, { agents: ["session"] }]);
  assert.deepEqual(await new WorkspaceRequestJournal(root).execute("request-one", operation), { agents: ["session"] });
  assert.deepEqual(launched, ["session"]);
});

test("an interrupted launch cannot be repeated by recovery or another delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-uncertain-"));
  const journal = new WorkspaceRequestJournal(root);
  const agents: string[] = [];
  await assert.rejects(journal.execute("interrupted", async () => { agents.push("possibly-started"); throw new Error("connection lost"); }));
  await assert.rejects(new WorkspaceRequestJournal(root).execute("interrupted", async () => { agents.push("duplicate"); }));
  assert.deepEqual(await journal.read("interrupted"), { state: "uncertain" });
  assert.deepEqual(agents, ["possibly-started"]);
});

test("only one active window may own a managed workspace identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-owner-claim-"));
  const first = await acquireWorkspaceOwner(root, "shared-owner");
  assert.notEqual(first, undefined);
  assert.equal(await acquireWorkspaceOwner(root, "shared-owner"), undefined);
  await first!.release();
  const reopened = await acquireWorkspaceOwner(root, "shared-owner");
  assert.notEqual(reopened, undefined);
  await reopened!.release();
});

test("ordinary folder windows retain an owner after reload while concurrent windows stay isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-ordinary-"));
  const first = await acquireOrdinaryWorkspaceOwner(root, process.cwd());
  const second = await acquireOrdinaryWorkspaceOwner(root, process.cwd());
  assert.notEqual(first.ownerId, second.ownerId);
  await first.release();
  const reloaded = await acquireOrdinaryWorkspaceOwner(root, process.cwd());
  assert.equal(reloaded.ownerId, first.ownerId);
  await second.release();
  await reloaded.release();
  const reopened = await acquireOrdinaryWorkspaceOwner(root, process.cwd());
  assert.equal(reopened.ownerId, reloaded.ownerId);
  await reopened.release();
});

test("a request identifier stays bound to its original plan during delivery and after reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-request-binding-"));
  const journal = new WorkspaceRequestJournal(root);
  let complete!: () => void;
  const paused = new Promise<void>((resolve) => { complete = resolve; });
  const original = journal.execute("bound-request", async () => { await paused; return { started: 1 }; }, { provider: "chatgpt", count: 1 });
  await assert.rejects(journal.execute("bound-request", async () => ({ started: 2 }), { provider: "claude", count: 2 }), WorkspaceRequestConflictError);
  complete();
  await original;
  const restored = new WorkspaceRequestJournal(root);
  await assert.rejects(restored.execute("bound-request", async () => ({ started: 2 }), { provider: "claude", count: 2 }), WorkspaceRequestConflictError);
  assert.deepEqual(await restored.execute("bound-request", async () => { throw new Error("must not run"); }, { count: 1, provider: "chatgpt" }), { started: 1 });
});
