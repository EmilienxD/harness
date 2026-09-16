import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { FileSystemPromptSpillStore, PromptSpillPathError, createPromptSpillRoot } from "../../src/platform/spill.js";
import { planLaunch } from "../../src/claude/launch.js";
import { promptSpillRoot, taskPromptPath } from "../../src/platform/launch.js";
import type { AgentId, SessionId } from "../../src/domain/contracts.js";

test("an activation owns a short isolated prompt root", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "aboard-prompt-root-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const promptRoot = await createPromptSpillRoot(parent);
  const otherRoot = await createPromptSpillRoot(parent);
  assert.equal(dirname(promptRoot), parent);
  assert.match(basename(promptRoot), /^abd-.{6}$/u);
  assert.notEqual(otherRoot, promptRoot);

  const agentId = "7" as AgentId;
  const store = new FileSystemPromptSpillStore("C:/project", "C:/runtime", new Map(), { promptRoot });
  const task = { agentId, relativePath: join(promptRoot, agentId, "task.md"), contents: "Address issue #7.\n" };
  assert.equal(await store.write(task), task.relativePath);
  assert.equal(await readFile(task.relativePath, "utf8"), task.contents);

  await assert.rejects(
    () => store.write({ ...task, relativePath: join(otherRoot, agentId, "task.md") }),
    (error: unknown) => error instanceof PromptSpillPathError,
  );
});

test("compaction restores an archived worker task into its activation root", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "aboard-task-reground-test-"));
  const runtimeRoot = join(parent, "runtime");
  const promptRoot = await createPromptSpillRoot(parent);
  const hookSettings = join(parent, "hooks.json");
  const hookScript = join(parent, "hook.py");
  t.after(async () => {
    await rm(parent, { recursive: true, force: true });
    await rm(promptSpillRoot(runtimeRoot), { recursive: true, force: true });
  });
  await writeFile(hookSettings, "{}\n", "utf8");
  await writeFile(hookScript, "# hook\n", "utf8");

  const agentId = "9" as AgentId;
  const plan = {
    ...planLaunch({
      agentId,
      sessionId: "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId,
      agentType: "implementer",
      shell: "powershell",
      configuration: { shape: "skill", skillName: "address-this" },
      prompt: "Address issue #9.",
      runtimeDirectory: runtimeRoot,
      promptRoot,
    }),
    platform: "claude" as const,
  };
  const store = new FileSystemPromptSpillStore(
    "C:/project",
    runtimeRoot,
    new Map([["claude", { settings: hookSettings, script: hookScript }]]),
    { promptRoot },
  );
  await store.prepare(plan);
  await store.remove(agentId);

  const restored = await store.task(agentId);

  assert.equal(restored?.path, `${promptRoot.replaceAll("\\", "/")}/9/task.md`);
  assert.equal(restored?.contents, "Address issue #9.");
  assert.equal(await readFile(restored?.path ?? "", "utf8"), "Address issue #9.");
});
