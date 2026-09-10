import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  E2eProtocolError,
  isRecord,
  parseAnthropicMessagesRequest,
  type AnthropicMessagesRequest,
  type AnthropicScenarioResponse,
} from "../../core/anthropic-protocol.js";

export const MARKER = "[E2E:on-edit-block]";
export const TARGET_BEFORE = "original target\n";
export const TARGET_AFTER = "updated after reading the guide\n";
export const GUIDE_MARKER = "E2E GUIDE: preserve the trailing newline.";

const FIRST_EDIT_ID = "toolu_e2e_on_edit_block_first";
const RETRY_EDIT_ID = "toolu_e2e_on_edit_block_retry";
const READ_TARGET_ID = "toolu_e2e_on_edit_block_read_target";

export const scenarioCatalogHash = createHash("sha256").update("on-edit-block:v1").digest("hex");
export const parseRequest = parseAnthropicMessagesRequest;

export function transition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const text = request.messages.flatMap((message) => textParts(message.content)).join("\n");
  if (!text.includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the on-edit-block scenario", "on-edit-block");
  for (const name of ["Read", "Edit"]) {
    if (!request.tools.some((tool) => tool.name === name)) throw new E2eProtocolError("$.tools", `required tool ${name} is unavailable`, "on-edit-block");
  }
  const read = resultFor(request, READ_TARGET_ID);
  const first = resultFor(request, FIRST_EDIT_ID);
  const retry = resultFor(request, RETRY_EDIT_ID);
  if (read === undefined) return readResponse(repoRoot);
  if (read.is_error === true || !textParts(read.content).join("\n").includes(TARGET_BEFORE.trimEnd())) {
    throw new E2eProtocolError("$.messages", "target Read did not return the baseline", "on-edit-block");
  }
  if (first === undefined) return editResponse("edit-denied", FIRST_EDIT_ID, repoRoot);
  const firstText = textParts(first.content).join("\n");
  if (first.is_error !== true || !firstText.includes(GUIDE_MARKER)) {
    const flags = ["hook", "blocked", "permission", "old_string", "not found", "does not exist"]
      .filter((value) => firstText.toLowerCase().includes(value.replace("_", " "))).join("|") || "none";
    throw new E2eProtocolError("$.messages", `first edit denial shape was invalid (is_error=${String(first.is_error)}, guide=${firstText.includes(GUIDE_MARKER)}, flags=${flags}, bytes=${Buffer.byteLength(firstText)})`, "on-edit-block");
  }
  if (retry === undefined) return editResponse("edit-retried", RETRY_EDIT_ID, repoRoot);
  if (retry.is_error === true) throw new E2eProtocolError("$.messages", "informed retry was denied", "on-edit-block");
  return {
    scenario: "on-edit-block",
    checkpoint: "complete",
    messageId: stableId("complete"),
    stopReason: "end_turn",
    content: [{ type: "text", text: "on-edit-block denied once and allowed the informed retry." }],
  };
}

function readResponse(repoRoot: string): AnthropicScenarioResponse {
  return {
    scenario: "on-edit-block",
    checkpoint: "read-target",
    messageId: stableId("read-target"),
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: READ_TARGET_ID, name: "Read", input: { file_path: join(repoRoot, "target.txt") } }],
  };
}

function editResponse(checkpoint: string, id: string, repoRoot: string): AnthropicScenarioResponse {
  return {
    scenario: "on-edit-block",
    checkpoint,
    messageId: stableId(checkpoint),
    stopReason: "tool_use",
    content: [{
      type: "tool_use",
      id,
      name: "Edit",
      input: {
        file_path: join(repoRoot, "target.txt"),
        old_string: TARGET_BEFORE.trimEnd(),
        new_string: TARGET_AFTER.trimEnd(),
        replace_all: false,
      },
    }],
  };
}

function resultFor(request: AnthropicMessagesRequest, id: string): Record<string, unknown> | undefined {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_result" && block.tool_use_id === id) return block;
    }
  }
  return undefined;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) return content.flatMap(textParts);
  if (isRecord(content)) return Object.values(content).flatMap(textParts);
  return [];
}

function stableId(checkpoint: string): string {
  return `msg_e2e_${createHash("sha256").update(`on-edit-block:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
