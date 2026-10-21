import assert from "node:assert/strict";
import test from "node:test";
import { runHookFailureJourney, type Failure, type HookEvent, type HookTool } from "../tools/hook-failures/run.js";

const cases: readonly [HookTool, HookEvent, Failure][] = [
  ["auto", "UserPromptSubmit", "exception"], ["auto", "UserPromptSubmit", "handled"], ["auto", "UserPromptSubmit", "completed"],
  ["commit", "UserPromptSubmit", "exception"], ["commit", "UserPromptSubmit", "handled"], ["commit", "UserPromptSubmit", "completed"],
  ["commit", "PreToolUse", "exception"], ["commit", "PostToolUse", "exception"],
  ["issue-writers", "UserPromptSubmit", "exception"],
  ["mid-prompt-skills", "UserPromptSubmit", "exception"],
  ["grill-me-in-cloud", "UserPromptSubmit", "exception"], ["grill-me-in-cloud", "PostToolUse", "exception"],
  ["subagents", "UserPromptSubmit", "exception"], ["subagents", "PreToolUse", "exception"],
  ["subagents", "PostToolUse", "exception"], ["subagents", "Stop", "exception"], ["subagents", "SessionStart", "exception"],
  ["no-new-documents", "PreToolUse", "policy"], ["no-new-documents", "PreToolUse", "exception"],
  ["no-new-documents", "UserPromptSubmit", "exception"],
  ["command-guard", "PreToolUse", "exception"], ["ship", "PreToolUse", "exception"],
];
for (const [tool, event, failure] of cases) {
  test(`Codex ${tool} ${event}: ${failure} yields the correct decision`, { timeout: 60_000 }, async () => {
    const result = await runHookFailureJourney(tool, event, failure);
    assert.equal(result.code, 0);
    assert.equal(result.inferenceRequests, event === "PreToolUse" || event === "PostToolUse" ? 2 : event === "Stop" ? 1 : 0);
    assert.equal(result.unexpectedRequests, 0);
    assert.equal(result.sentinel, event === "PostToolUse" || (tool === "commit" && failure === "completed") ? "after\n" : "before\n");
    if (tool === "commit" && failure === "completed") assert.equal(result.commitSubject, "fixture completion");
  });
}
