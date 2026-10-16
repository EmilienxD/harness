import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorkspaceFiles, acquireWorkspaceOwner } from "../../src/runtime/agent-workspace-owner.js";
import { WorkspaceStartup } from "../../src/runtime/workspace-startup.js";

const plan = { preset: { id: "pair", name: "Pair", columns: 1, rows: 2, panes: [{ providers: ["chatgpt"] }, { providers: ["chatgpt"] }] }, empty: false };

test("closing the owner before initialization releases startup and prevents a delayed launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handoff = await new AgentWorkspaceFiles(root).create(process.cwd(), plan);
  const ownership = await acquireWorkspaceOwner(root, handoff.ownerId);
  assert.ok(ownership);
  t.after(() => ownership.release());
  const startup = new WorkspaceStartup(root, handoff);
  await startup.opened();
  await ownership.release();

  const result = await startup.wait({ sleep: async () => assert.fail("a closed owner must finish without polling until the startup deadline") });
  assert.deepEqual(result, { started: 0, failed: [], cancelled: 2 });
  let launches = 0;
  const late = await new WorkspaceStartup(root, handoff).execute(async () => {
    launches++;
    return { started: 2, failed: [], cancelled: 0 };
  });
  assert.equal(launches, 0);
  assert.deepEqual(late, result);
});

test("a window closed before extension activation expires without allowing its delayed startup to run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-unopened-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handoff = await new AgentWorkspaceFiles(root).create(process.cwd(), plan);
  const startup = new WorkspaceStartup(root, handoff);
  let elapsed = 0;
  const result = await startup.wait({ activationTimeoutMs: 10, timeoutMs: 40, now: () => elapsed, sleep: async () => { elapsed += 10; } });
  assert.deepEqual(result, { started: 0, failed: [], cancelled: 2 });
  assert.equal(elapsed, 10);
  let launches = 0;
  await new WorkspaceStartup(root, handoff).execute(async () => {
    launches++;
    return { started: 2, failed: [], cancelled: 0 };
  });
  assert.equal(launches, 0);
});

test("closing after startup effects began releases the waiter without replaying the uncertain request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handoff = await new AgentWorkspaceFiles(root).create(process.cwd(), plan);
  const ownership = await acquireWorkspaceOwner(root, handoff.ownerId);
  assert.ok(ownership);
  t.after(() => ownership.release());
  const owner = new WorkspaceStartup(root, handoff);
  await owner.opened();
  await assert.rejects(owner.execute(async () => { throw new Error("window closed during launch"); }));
  await ownership.release();

  assert.deepEqual(await new WorkspaceStartup(root, handoff).wait(), { started: 0, failed: [], cancelled: 2 });
  let repeats = 0;
  await assert.rejects(new WorkspaceStartup(root, handoff).execute(async () => {
    repeats++;
    return { started: 2, failed: [], cancelled: 0 };
  }));
  assert.equal(repeats, 0);
});
