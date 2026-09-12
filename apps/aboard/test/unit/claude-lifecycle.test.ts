import assert from "node:assert/strict";
import test from "node:test";

import { classifyClaudeFailure, normalizeClaudeLifecycle } from "../../src/claude/lifecycle.js";

test("Claude hook payloads normalize into the shared lifecycle contract", () => {
  assert.deepEqual(normalizeClaudeLifecycle("start", {
    agentId: "agent-1", session_id: "session-1", source: "startup",
  }), { type: "start", agentId: "agent-1", sessionId: "session-1", source: "startup" });
  assert.deepEqual(normalizeClaudeLifecycle("end", {
    agentId: "agent-1", sessionId: "session-1", reason: "clear",
  }), { type: "end", agentId: "agent-1", sessionId: "session-1", reason: "clear" });
  assert.deepEqual(normalizeClaudeLifecycle("stop", {
    agentId: "agent-1", session_id: "session-1", cwd: "C:\\repo", last_assistant_message: "done",
  }), { type: "stop", agentId: "agent-1", sessionId: "session-1", cwd: "C:\\repo", lastAssistantMessage: "done" });
  assert.deepEqual(normalizeClaudeLifecycle("failure", {
    agentId: "agent-1", session_id: "session-1", error: "authentication_failed", error_details: "OAuth denied",
  }), { type: "failure", agentId: "agent-1", sessionId: "session-1", failureType: "permission-denied", message: "OAuth denied", exitCode: null });
  assert.deepEqual(normalizeClaudeLifecycle("compaction", {
    agentId: "agent-1", sessionId: "session-1", compactSummary: "summary",
  }), { type: "compaction", agentId: "agent-1", sessionId: "session-1", summary: "summary" });
});

test("Claude normalization rejects unknown end reasons and malformed payloads", () => {
  assert.throws(() => normalizeClaudeLifecycle("end", { agentId: "a", sessionId: "s", reason: "mystery" }), /reason must be one of/);
  assert.throws(() => normalizeClaudeLifecycle("stop", { agentId: "a" }), /sessionId/);
});

test("Claude failure classification stays inside its adapter", () => {
  assert.equal(classifyClaudeFailure("max_output_tokens", "limit"), "context-exhausted");
  assert.equal(classifyClaudeFailure("authentication_failed", "OAuth denied"), "permission-denied");
  assert.equal(classifyClaudeFailure("unexpected", "process exited"), "crashed");
});
