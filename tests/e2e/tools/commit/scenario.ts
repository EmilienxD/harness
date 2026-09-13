import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseAnthropicMessagesRequest, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";

export const MARKER = "[E2E:commit]";
export const BEFORE = "harness e2e fixture: before\n";
export const AFTER = "harness e2e fixture: committed\n";
const READ = "toolu_e2e_commit_read";
const EDIT = "toolu_e2e_commit_edit";
export const parseRequest = parseAnthropicMessagesRequest;
export const scenarioCatalogHash = createHash("sha256").update("commit:v1").digest("hex");

export function transition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const text = JSON.stringify(request.messages);
  if (!text.includes(MARKER)) throw new Error("commit marker missing");
  const has = (id: string) => request.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_result" && (b as Record<string, unknown>).tool_use_id === id));
  if (!has(READ)) return { scenario: "commit", checkpoint: "read", messageId: "msg_e2e_commit_read", stopReason: "tool_use", content: [{ type: "tool_use", id: READ, name: "Read", input: { file_path: join(repoRoot, "deterministic.txt") } }] };
  if (!has(EDIT)) return { scenario: "commit", checkpoint: "edit", messageId: "msg_e2e_commit_edit", stopReason: "tool_use", content: [{ type: "tool_use", id: EDIT, name: "Edit", input: { file_path: join(repoRoot, "deterministic.txt"), old_string: BEFORE.trimEnd(), new_string: AFTER.trimEnd(), replace_all: false } }] };
  return { scenario: "commit", checkpoint: "complete", messageId: "msg_e2e_commit_complete", stopReason: "end_turn", content: [{ type: "text", text: "Edited the fixture; commit it with /commit." }] };
}
