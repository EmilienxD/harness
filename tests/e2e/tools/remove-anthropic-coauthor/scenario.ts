import { createHash } from "node:crypto";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";

export const MARKER = "[E2E:remove-anthropic-coauthor]";
export const scenarioCatalogHash = createHash("sha256").update("remove-anthropic-coauthor:v1").digest("hex");
const OPUS = "toolu_e2e_remove_coauthor_opus";
const SONNET = "toolu_e2e_remove_coauthor_sonnet";

export function transition(request: AnthropicMessagesRequest): AnthropicScenarioResponse {
  if (!JSON.stringify(request.messages).includes(MARKER)) fail("scenario marker missing");
  if (!request.tools.some((tool) => tool.name === "Bash")) fail("Bash unavailable");
  const calls: string[] = [];
  const results: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use") {
        const expected = calls.length === 0 ? OPUS : calls.length === 1 ? SONNET : undefined;
        if (message.role !== "assistant" || block.id !== expected || block.name !== "Bash") fail("unexpected tool call or ordering");
        const expectedResponse = calls.length === 0
          ? commit("commit-opus", OPUS, "Opus", "Claude Opus 4.7", "opus committed")
          : commit("commit-sonnet", SONNET, "Sonnet", "Claude Sonnet 4.8", "sonnet committed");
        const expectedInput = expectedResponse.content[0]!.input as Record<string, unknown>;
        if (!isRecord(block.input) || block.input.command !== expectedInput.command) fail("unexpected commit command");
        calls.push(block.id as string);
      }
      if (block.type === "tool_result") {
        if (message.role !== "user" || block.tool_use_id !== calls[results.length]) fail("unexpected tool result or ordering");
        if (block.is_error === true) fail("fixture commit failed");
        results.push(block);
      }
    }
  }
  if (calls.length !== results.length) fail("tool call has no result");
  if (results.length === 0) return commit("commit-opus", OPUS, "Opus", "Claude Opus 4.7", "opus committed");
  if (results.length === 1) return commit("commit-sonnet", SONNET, "Sonnet", "Claude Sonnet 4.8", "sonnet committed");
  return {
    scenario: "remove-anthropic-coauthor", checkpoint: "complete", messageId: "msg_e2e_remove_coauthor_complete",
    stopReason: "end_turn", content: [{ type: "text", text: "Both fixture commits completed." }],
  };
}

function commit(checkpoint: string, id: string, title: string, model: string, bytes: string): AnthropicScenarioResponse {
  const command = `printf '%s\\n' '${bytes}' > coauthor-fixture.txt && git add -- coauthor-fixture.txt && git commit --only -m '${title} fixture' -m 'Co-Authored-By: Alice <alice@example.invalid>\nCo-Authored-By: ${model} <noreply@anthropic.com>' -- coauthor-fixture.txt`;
  return {
    scenario: "remove-anthropic-coauthor", checkpoint, messageId: `msg_e2e_remove_coauthor_${title.toLowerCase()}`,
    stopReason: "tool_use", content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
  };
}

function fail(detail: string): never {
  throw new E2eProtocolError("$.messages", detail, "remove-anthropic-coauthor");
}
