import { createHash } from "node:crypto";

import { E2eProtocolError, isRecord, parseAnthropicMessagesRequest, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";

export const MARKER = "[E2E:prefer-read-tool]";
export const TARGET_CONTENT = "content read through the shell\n";
const SHELL_READ_ID = "toolu_e2e_prefer_read_tool_shell_read";

export const scenarioCatalogHash = createHash("sha256").update("prefer-read-tool:v1").digest("hex");
export const parseRequest = parseAnthropicMessagesRequest;

export function transition(request: AnthropicMessagesRequest): AnthropicScenarioResponse {
  const allText = textParts(request.messages).join("\n");
  if (!allText.includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "prefer-read-tool");
  if (!request.tools.some((tool) => tool.name === "Bash")) throw new E2eProtocolError("$.tools", "Bash is unavailable", "prefer-read-tool");
  const result = resultFor(request, SHELL_READ_ID);
  if (result === undefined) {
    return {
      scenario: "prefer-read-tool", checkpoint: "shell-read", messageId: stableId("shell-read"), stopReason: "tool_use",
      content: [{ type: "tool_use", id: SHELL_READ_ID, name: "Bash", input: { command: "cat target.txt", description: "Read the deterministic target through the shell" } }],
    };
  }
  if (result.is_error === true || !allText.includes(TARGET_CONTENT.trimEnd()) || !allText.includes("built-in Read tool") || !allText.includes("shelling out")) {
    throw new E2eProtocolError("$.messages", "shell read did not carry the native-read nudge", "prefer-read-tool");
  }
  return {
    scenario: "prefer-read-tool", checkpoint: "complete", messageId: stableId("complete"), stopReason: "end_turn",
    content: [{ type: "text", text: "Shell read completed with the native-read reminder." }],
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
  return `msg_e2e_${createHash("sha256").update(`prefer-read-tool:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
