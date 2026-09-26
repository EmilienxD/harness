import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { claudeSessionTitle } from "../../src/claude/sessions.js";
import { ChatGptSessionProbe } from "../../src/chatgpt/sessions.js";
import type { SessionId } from "../../src/domain/contracts.js";

test("Claude title lookup prefers a generated title over an old aboard launch name", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-title-"));
  const cwd = "C:/checkout";
  const id = "11111111-1111-4111-8111-111111111111" as SessionId;
  const path = join(root, "projects", "C--checkout", `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    JSON.stringify({ type: "custom-title", customTitle: "aboard-interactive-5", sessionId: id }),
    JSON.stringify({ type: "ai-title", aiTitle: "Repair checkout recovery", sessionId: id }),
  ].join("\n"));
  assert.equal(await claudeSessionTitle(id, cwd, root), "Repair checkout recovery");
});

test("Codex title lookup uses its saved name and falls back to its preview", async () => {
  let name: string | null = "Repair checkout recovery";
  const probe = new ChatGptSessionProbe({ exchange: async () => ({ thread: {
    id: "thread-1", name, preview: "The first message", ephemeral: false, status: { type: "idle" },
  } }) });
  assert.equal(await probe.title("thread-1" as SessionId, "C:/checkout"), "Repair checkout recovery");
  name = null;
  assert.equal(await probe.title("thread-1" as SessionId, "C:/checkout"), "The first message");
});
