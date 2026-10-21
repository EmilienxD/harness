import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatGptSessionProbe,
  ChatGptSessionProbeError,
  type ChatGptAppServerExchange,
} from "../../src/chatgpt/sessions.js";
import type { SessionId } from "../../src/domain/contracts.js";

const sessionId = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;

test("ChatGPT resumability reads the exact thread through the configured Codex command", async () => {
  const calls: Parameters<ChatGptAppServerExchange>[0][] = [];
  const probe = new ChatGptSessionProbe({
    exchange: async (request) => {
      calls.push(request);
      return request.method === "thread/read"
        ? { thread: { id: sessionId, ephemeral: false, status: { type: "notLoaded" } } }
        : { data: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "Repair login" }] }] }] };
    },
  });

  assert.deepEqual(await probe.inspect(sessionId, "C:/work", ["wrapper", "codex"]), { state: "resumable" });
  assert.deepEqual(calls, [{
    command: ["wrapper", "codex"],
    cwd: "C:/work",
    method: "thread/read",
    params: { threadId: sessionId, includeTurns: false },
  }, {
    command: ["wrapper", "codex"], cwd: "C:/work", method: "thread/turns/list",
    params: { threadId: sessionId, limit: 1, sortDirection: "asc", itemsView: "full" },
  }]);
});

test("a saved Codex name or preview does not make a conversation without user messages reopenable", async () => {
  const probe = new ChatGptSessionProbe({ exchange: async (request) => request.method === "thread/read"
    ? { thread: { id: sessionId, name: "Draft task", preview: "A goal", status: { type: "idle" } } }
    : { data: [] } });
  assert.equal((await probe.inspect(sessionId, "C:/work")).state, "non-resumable");
  assert.equal(await probe.title(sessionId, "C:/work"), undefined);
});

test("Codex finds the first user message after a turn containing only setup items", async () => {
  const probe = new ChatGptSessionProbe({ exchange: async (request) => {
    if (request.method === "thread/read") return { thread: { id: sessionId, name: null, preview: "A goal" } };
    return request.params.cursor === "next"
      ? { data: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "Repair login" }] }] }], nextCursor: null }
      : { data: [{ items: [] }], nextCursor: "next" };
  } });
  assert.equal(await probe.title(sessionId, "C:/work"), "Repair login");
});

test("ChatGPT resumability distinguishes missing and non-persisted conversations", async () => {
  const missing = new ChatGptSessionProbe({ exchange: async () => { throw { code: -32600, message: "thread not found" }; } });
  assert.deepEqual(await missing.inspect(sessionId, "C:/work", ["codex"]), {
    state: "missing",
    reason: "Codex no longer has that saved conversation",
  });
  const notLoaded = new ChatGptSessionProbe({ exchange: async () => { throw { code: -32600, message: "thread not loaded" }; } });
  assert.deepEqual(await notLoaded.inspect(sessionId, "C:/work", ["codex"]), {
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
