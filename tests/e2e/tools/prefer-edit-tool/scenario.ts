import { createHash } from "node:crypto";

import { E2eProtocolError, isRecord, parseAnthropicMessagesRequest, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";

export const MARKER = "[E2E:prefer-edit-tool]";
export const TARGET_CONTENT = "shell-created\n";
const SHELL_WRITE_ID = "toolu_e2e_prefer_edit_tool_shell_write";

export const scenarioCatalogHash = createHash("sha256").update("prefer-edit-tool:v1").digest("hex");
export const parseRequest = parseAnthropicMessagesRequest;

export function transition(request: AnthropicMessagesRequest): AnthropicScenarioResponse {
  const allText = textParts(request.messages).join("\n");
  if (!allText.includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "prefer-edit-tool");
  if (!request.tools.some((tool) => tool.name === "Bash")) throw new E2eProtocolError("$.tools", "Bash is unavailable", "prefer-edit-tool");
  const result = resultFor(request, SHELL_WRITE_ID);
  if (result === undefined) {
    return {
      scenario: "prefer-edit-tool", checkpoint: "shell-write", messageId: stableId("shell-write"), stopReason: "tool_use",
      content: [{ type: "tool_use", id: SHELL_WRITE_ID, name: "Bash", input: { command: "printf 'shell-created\\n' > target.txt", description: "Create the deterministic target through the shell" } }],
    };
  }
  if (result.is_error === true || !allText.includes("Write and Edit tools") || !allText.includes("redirect to target.txt") || !allText.includes("reviewable diff")) {
    throw new E2eProtocolError("$.messages", "shell write did not carry the native-edit nudge", "prefer-edit-tool");
  }
  return {
    scenario: "prefer-edit-tool", checkpoint: "complete", messageId: stableId("complete"), stopReason: "end_turn",
    content: [{ type: "text", text: "Shell write completed with the native-edit reminder." }],
  };
}

function resultFor(request: AnthropicMessagesRequest, id: string): Record<string, unknown> | undefined {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) if (isRecord(block) && block.type === "tool_result" && block.tool_use_id === id) return block;
  }
  return undefined;
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textParts);
  if (isRecord(value)) return Object.values(value).flatMap(textParts);
  return [];
}

function stableId(checkpoint: string): string {
  return `msg_e2e_${createHash("sha256").update(`prefer-edit-tool:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
