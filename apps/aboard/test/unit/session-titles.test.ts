import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { claudeSessionTitle } from "../../src/claude/sessions.js";
import { ChatGptSessionProbe } from "../../src/chatgpt/sessions.js";
import { inspectPiSession } from "../../src/pi/sessions.js";
import type { SessionId } from "../../src/domain/contracts.js";

test("Pi uses the native session name across branches and honours clearing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-pi-name-"));
  const id = "33333333-3333-4333-8333-333333333333" as SessionId;
  const rows = [
    { type: "session", id, cwd: "C:/checkout" },
    { type: "message", id: "user", parentId: null, message: { role: "user", content: "Repair login" } },
    { type: "session_info", id: "name", parentId: "user", name: "Fix authentication" },
    { type: "message", id: "branch", parentId: "user", message: { role: "assistant", content: [] } },
  ];
  const path = join(root, `${id}.jsonl`);
  const command = ["pi", "--session-dir", root];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  assert.equal((await inspectPiSession(id, "C:/checkout", command))?.title, "Fix authentication");
  rows.push({ type: "session_info", id: "clear", parentId: "branch", name: "" });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + '\n{"type":');
  assert.equal((await inspectPiSession(id, "C:/checkout", command))?.title, "Repair login");
});

test("Pi skill conversations are named after the user's invocation rather than expanded instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-pi-title-"));
  const cwd = "C:/checkout";
  const id = "22222222-2222-4222-8222-222222222222" as SessionId;
  await writeFile(join(root, `${id}.jsonl`), [
    { type: "session", id, cwd },
    { type: "message", id: "user", parentId: null, message: { role: "user", content: [
      { type: "text", text: '<skill name="address-this" location="C:/skills/address-this/SKILL.md">\nExpanded instructions\n</skill>\n\nRepair login' },
    ] } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  assert.equal((await inspectPiSession(id, cwd, ["pi", "--session-dir", root]))?.title, "/skill:address-this Repair login");
});

test("Claude title lookup prefers a generated title over an old aboard launch name", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-title-"));
  const cwd = "C:/checkout";
  const id = "11111111-1111-4111-8111-111111111111" as SessionId;
  const path = join(root, "projects", "C--checkout", `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    JSON.stringify({ type: "user", sessionId: id, message: { role: "user", content: "Repair checkout recovery" } }),
    JSON.stringify({ type: "custom-title", customTitle: "aboard-interactive-5", sessionId: id }),
    JSON.stringify({ type: "ai-title", aiTitle: "Repair checkout recovery", sessionId: id }),
  ].join("\n"));
  assert.equal(await claudeSessionTitle(id, cwd, root), "Repair checkout recovery");
});

test("Codex title lookup uses its saved name and falls back to the first user message", async () => {
  let name: string | null = "Repair checkout recovery";
  const probe = new ChatGptSessionProbe({ exchange: async (request) => request.method === "thread/read" ? ({ thread: {
    id: "thread-1", name, preview: "A metadata preview", ephemeral: false, status: { type: "idle" },
  } }) : ({ data: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "The first message" }] }] }] }) });
  assert.equal(await probe.title("thread-1" as SessionId, "C:/checkout"), "Repair checkout recovery");
  name = null;
  assert.equal(await probe.title("thread-1" as SessionId, "C:/checkout"), "The first message");
});
