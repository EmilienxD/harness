import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  E2eProtocolError,
  isRecord,
  parseAnthropicMessagesRequest,
  type AnthropicMessagesRequest,
  type AnthropicScenarioResponse,
} from "../../core/anthropic-protocol.js";

export const MARKER = "[E2E:on-edit-reminder]";
export const TARGET_BEFORE = "original value\n";
export const TARGET_AFTER_FIRST_EDIT = "noncompliant value\n";
export const TARGET_AFTER = "compliant value\n";
export const GUIDE_MARKER = "E2E GUIDE: the value must be compliant.";

const READ_TARGET_ID = "toolu_e2e_on_edit_reminder_read_target";
const FIRST_EDIT_ID = "toolu_e2e_on_edit_reminder_first_edit";
const READ_GUIDE_ID = "toolu_e2e_on_edit_reminder_read_guide";
const CORRECTION_ID = "toolu_e2e_on_edit_reminder_correction";

export const scenarioCatalogHash = createHash("sha256").update("on-edit-reminder:v1").digest("hex");
export const parseRequest = parseAnthropicMessagesRequest;

export function transition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const allText = textParts(request.messages).join("\n");
  if (!allText.includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "on-edit-reminder");
  for (const name of ["Read", "Edit"]) {
    if (!request.tools.some((tool) => tool.name === name)) throw new E2eProtocolError("$.tools", `required tool ${name} is unavailable`, "on-edit-reminder");
  }

  const targetRead = resultFor(request, READ_TARGET_ID);
  const firstEdit = resultFor(request, FIRST_EDIT_ID);
  const guideRead = resultFor(request, READ_GUIDE_ID);
  const correction = resultFor(request, CORRECTION_ID);
  if (targetRead === undefined) return toolResponse("read-target", READ_TARGET_ID, "Read", { file_path: join(repoRoot, "target.txt") });
  if (targetRead.is_error === true || !textParts(targetRead.content).join("\n").includes(TARGET_BEFORE.trimEnd())) {
    throw new E2eProtocolError("$.messages", "target Read did not return the baseline", "on-edit-reminder");
  }
  if (firstEdit === undefined) return editResponse("edit-landed", FIRST_EDIT_ID, repoRoot, TARGET_BEFORE, TARGET_AFTER_FIRST_EDIT);
  if (firstEdit.is_error === true || !allText.includes("on-edit-reminder.toml") || !allText.includes("GUIDE.md") || !allText.includes("Read")) {
    throw new E2eProtocolError("$.messages", "landed edit did not carry the required-reading reminder", "on-edit-reminder");
  }
  if (guideRead === undefined) return toolResponse("read-guide", READ_GUIDE_ID, "Read", { file_path: join(repoRoot, "GUIDE.md") });
  if (guideRead.is_error === true || !textParts(guideRead.content).join("\n").includes(GUIDE_MARKER)) {
    throw new E2eProtocolError("$.messages", "required guide was not read", "on-edit-reminder");
  }
  if (correction === undefined) return editResponse("corrected", CORRECTION_ID, repoRoot, TARGET_AFTER_FIRST_EDIT, TARGET_AFTER);
  if (correction.is_error === true) throw new E2eProtocolError("$.messages", "guide-driven correction failed", "on-edit-reminder");
  return {
    scenario: "on-edit-reminder", checkpoint: "complete", messageId: stableId("complete"), stopReason: "end_turn",
    content: [{ type: "text", text: "The edit landed, the required guide was read, and the target was corrected." }],
  };
}

function editResponse(checkpoint: string, id: string, repoRoot: string, before: string, after: string): AnthropicScenarioResponse {
  return toolResponse(checkpoint, id, "Edit", {
    file_path: join(repoRoot, "target.txt"), old_string: before.trimEnd(), new_string: after.trimEnd(), replace_all: false,
  });
}

function toolResponse(checkpoint: string, id: string, name: string, input: Record<string, unknown>): AnthropicScenarioResponse {
  return {
    scenario: "on-edit-reminder", checkpoint, messageId: stableId(checkpoint), stopReason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
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

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textParts);
  if (isRecord(value)) return Object.values(value).flatMap(textParts);
  return [];
}

function stableId(checkpoint: string): string {
  return `msg_e2e_${createHash("sha256").update(`on-edit-reminder:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
