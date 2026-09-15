import { createHash } from "node:crypto";
import { join } from "node:path";

import { E2eProtocolError, isRecord, parseAnthropicMessagesRequest, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";

export const MARKER = "[E2E:on-read-reminder]";
export const FINAL_MESSAGE = "Required reading completed.";
export const TRIGGER_CONTENT = "trigger content\n";
export const REQUIRED_MARKER = "E2E REQUIRED READING";
const READ_TRIGGER_ID = "toolu_e2e_on_read_reminder_trigger";
const READ_REQUIRED_ID = "toolu_e2e_on_read_reminder_required";

export const scenarioCatalogHash = createHash("sha256").update("on-read-reminder:v1").digest("hex");
export const parseRequest = parseAnthropicMessagesRequest;

export function transition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const allText = textParts(request.messages).join("\n");
  if (!allText.includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "on-read-reminder");
  if (!request.tools.some((tool) => tool.name === "Read")) throw new E2eProtocolError("$.tools", "Read is unavailable", "on-read-reminder");
  const trigger = resultFor(request, READ_TRIGGER_ID);
  const required = resultFor(request, READ_REQUIRED_ID);
  if (trigger === undefined) return readResponse("read-trigger", READ_TRIGGER_ID, join(repoRoot, "trigger.txt"));
  if (trigger.is_error === true || !allText.includes(TRIGGER_CONTENT.trimEnd()) || !allText.includes("on-read-reminder.toml") || !allText.includes("GUIDE.md")) {
    throw new E2eProtocolError("$.messages", "matched read did not carry the required-file reminder", "on-read-reminder");
  }
  if (required === undefined) return readResponse("read-required", READ_REQUIRED_ID, join(repoRoot, "GUIDE.md"));
  if (required.is_error === true || !allText.includes(REQUIRED_MARKER)) {
    throw new E2eProtocolError("$.messages", "required file was not read", "on-read-reminder");
  }
  return {
    scenario: "on-read-reminder", checkpoint: "complete", messageId: stableId("complete"), stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_MESSAGE }],
  };
}

function readResponse(checkpoint: string, id: string, filePath: string): AnthropicScenarioResponse {
  return {
    scenario: "on-read-reminder", checkpoint, messageId: stableId(checkpoint), stopReason: "tool_use",
    content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }],
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
  return `msg_e2e_${createHash("sha256").update(`on-read-reminder:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
