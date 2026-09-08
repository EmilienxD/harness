import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ChatGptSessionProbe,
  ChatGptSessionProbeError,
  type ChatGptAppServerExchange,
} from "../src/chatgpt/sessions.js";
import type { SessionId } from "../src/domain/contracts.js";

const sessionId = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;

test("ChatGPT resumability reads the exact thread through the configured Codex command", async () => {
  const calls: Parameters<ChatGptAppServerExchange>[0][] = [];
  const probe = new ChatGptSessionProbe({
    exchange: async (request) => {
      calls.push(request);
      return { thread: { id: sessionId, ephemeral: false, status: { type: "notLoaded" } } };
    },
  });

  assert.deepEqual(await probe.inspect(sessionId, "C:/work", ["wrapper", "codex"]), { state: "resumable" });
  assert.deepEqual(calls, [{
    command: ["wrapper", "codex"],
    cwd: "C:/work",
    method: "thread/read",
    params: { threadId: sessionId, includeTurns: false },
  }]);
});

test("ChatGPT resumability distinguishes missing and non-persisted conversations", async () => {
  const missing = new ChatGptSessionProbe({ exchange: async () => { throw { code: -32600, message: "thread not found" }; } });
  assert.deepEqual(await missing.inspect(sessionId, "C:/work", ["codex"]), {
    state: "missing",
    reason: "Codex no longer has that saved conversation",
  });

  const ephemeral = new ChatGptSessionProbe({
    exchange: async () => ({ thread: { id: sessionId, ephemeral: true, status: { type: "notLoaded" } } }),
  });
  assert.deepEqual(await ephemeral.inspect(sessionId, "C:/work", ["codex"]), {
    state: "non-resumable",
    reason: "the Codex conversation was not persisted",
  });
});

test("ChatGPT resumability reports corrupt or unreadable conversation state separately from launch failures", async () => {
  const probe = new ChatGptSessionProbe({ exchange: async () => { throw { code: -32603, message: "failed to decode rollout" }; } });
  await assert.rejects(
    () => probe.inspect(sessionId, "C:/work", ["codex"]),
    (error: unknown) => error instanceof ChatGptSessionProbeError
      && error.kind === "unreadable"
      && /could not read/u.test(error.message)
      && /failed to decode rollout/u.test(error.message),
  );
});

test("ChatGPT resumability speaks the supported App Server protocol over stdio", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "aboard-chatgpt-sessions-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".fake-codex-session.json"), `${JSON.stringify({ sessionId })}\n`, "utf8");
  const probe = new ChatGptSessionProbe({ timeoutMs: 5_000 });
  const command = [process.execPath, resolve(process.cwd(), "e2e", "fake-codex.mjs")];

  assert.deepEqual(await probe.inspect(sessionId, cwd, command), { state: "resumable" });
  assert.deepEqual(await probe.inspect("c15badb6-d6c8-45a6-a59f-e931cd364332" as SessionId, cwd, command), {
    state: "missing",
    reason: "Codex no longer has that saved conversation",
  });
});
