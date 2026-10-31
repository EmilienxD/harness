import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeAgentPlatform } from "../../src/claude/platform.js";
import { ChatGptAgentPlatform } from "../../src/chatgpt/platform.js";
import { PiAgentPlatform } from "../../src/pi/platform.js";
import type { AgentId, SessionId, IsoTimestamp } from "../../src/domain/contracts.js";
import { renderReopenItems, reopenItemsForQuery } from "../../src/vscode/reopen.js";

const sessionId = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;
const agentId = "general-1" as AgentId;

const options = { commandRunner: async () => ({ code: 0, stdout: "", stderr: "" }), lifecycleAssets: { settings: "hooks.json", script: "hook.py" } };
for (const platform of [new ClaudeAgentPlatform(options), new ChatGptAgentPlatform(options), new PiAgentPlatform(options)]) {
  test(`${platform.id} user reopen omits model and effort while ordinary continuation retains overrides`, () => {
    const request = {
      agentId, sessionId, agentType: "general" as const, shell: "powershell" as const,
      runtimeDirectory: "C:/storage/aboard", executionMode: "interactive" as const,
      configuration: { shape: "default", declaredModel: platform.id === "claude" ? "opus" : "gpt-5.6-sol", declaredEffort: "high" },
      modelOverride: platform.id === "claude" ? "sonnet" : "gpt-5.6-luna", effortOverride: "low" as const,
    };
    const ordinary = platform.planSessionResume(request);
    assert.ok(ordinary.args.includes("--model"));
    const preserved = platform.planSessionResume({ ...request, preserveSessionModel: true });
    for (const flag of ["--model", "--effort", "--thinking"]) assert.equal(preserved.args.includes(flag), false);
    assert.equal(preserved.args.some((arg) => arg.startsWith("model_reasoning_effort=")), false);
    assert.deepEqual(preserved.command, ordinary.command);
    assert.ok(preserved.args.includes(sessionId));
  });
}

test("pasted UUID selects a recorded session without adding IDs to visible rows", () => {
  const items = renderReopenItems([{
    resumable: true,
    candidate: { platform: "pi", agentId, sessionId, type: "general", title: "A conversation", description: "Pi", origin: "ended", at: "2026-10-30T10:00:00.000Z" as IsoTimestamp },
  }]);
  const matched = reopenItemsForQuery(items, ` ${sessionId.toUpperCase()} `);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.alwaysShow, true);
  assert.equal(matched[0]?.option.candidate.sessionId, sessionId);
  assert.deepEqual([matched[0]?.label, matched[0]?.description, matched[0]?.detail], [items[0]?.label, items[0]?.description, items[0]?.detail]);
  assert.equal(reopenItemsForQuery(items, "conversation"), items);
  assert.equal(reopenItemsForQuery(items, "unknown-id"), items);
  assert.equal(reopenItemsForQuery(items, ""), items);
});
