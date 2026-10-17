import assert from "node:assert/strict";
import test from "node:test";
import { summarizeProgressEvent } from "../../src/vscode/progress.js";

test("background progress describes observed Claude and Codex research steps", () => {
  assert.equal(summarizeProgressEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "current evidence" } }] } }), "Search started: current evidence");
  assert.equal(summarizeProgressEvent({ type: "item.started", item: { type: "web_search", query: "live sources" } }), "Search started: live sources");
  assert.equal(summarizeProgressEvent({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }), "Turn finished · 100 input, 20 output tokens");
  assert.equal(summarizeProgressEvent({ type: "result", usage: { input_tokens: 140, output_tokens: 30 } }), "Finished · 140 input, 30 output tokens");
});

test("background progress describes Pi tools and final turn settlement", () => {
  assert.equal(summarizeProgressEvent({ type: "tool_execution_start", toolName: "read", args: { path: "src/main.ts" } }), "read started: src/main.ts");
  assert.equal(summarizeProgressEvent({ type: "tool_execution_end", toolName: "write", isError: true }), "write failed");
  assert.equal(summarizeProgressEvent({ type: "agent_settled", aborted: true }), "Turn aborted");
});
