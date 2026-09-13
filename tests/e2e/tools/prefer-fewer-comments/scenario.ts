import { createHash } from "node:crypto";
import { join } from "node:path";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const MARKER = "[E2E:prefer-fewer-comments]";
export const LONG_COMMENT = `# ${"This comment narrates an obvious implementation detail that belongs in the conversation instead of the source file. ".repeat(3).trimEnd()}`;
export const TARGET_CONTENT = `value = 1\n${LONG_COMMENT}\n`;
export const FINAL_MESSAGE = "The comment-heavy write completed and the budget reminder was observed.";
const CLAUDE_WRITE_ID = "toolu_e2e_prefer_fewer_comments_write";
const CODEX_WRITE_ID = "call_e2e_prefer_fewer_comments_write";

export const scenarioCatalogHash = createHash("sha256").update("prefer-fewer-comments:v1").digest("hex");

export function claudeTransition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const allText = deepText(request.messages);
  if (!allText.includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "prefer-fewer-comments");
  if (!request.tools.some((tool) => tool.name === "Write")) throw new E2eProtocolError("$.tools", "Write is unavailable", "prefer-fewer-comments");
  const result = claudeResult(request, CLAUDE_WRITE_ID);
  if (result === undefined) {
    return {
      scenario: "prefer-fewer-comments", checkpoint: "comment-heavy-write", messageId: stableId("claude-write"), stopReason: "tool_use",
      content: [{ type: "tool_use", id: CLAUDE_WRITE_ID, name: "Write", input: { file_path: join(repoRoot, "target.py"), content: TARGET_CONTENT } }],
    };
  }
  if (result.is_error === true || !hasBudgetReminder(allText)) {
    throw new E2eProtocolError("$.messages", "Write did not carry the comment-budget reminder", "prefer-fewer-comments");
  }
  return {
    scenario: "prefer-fewer-comments", checkpoint: "complete", messageId: stableId("claude-complete"), stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_MESSAGE }],
  };
}

export function codexTransition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
  const allText = deepText(request.input);
  if (!allText.includes(MARKER)) throw new OpenAiProtocolError("$.input", "does not select the scenario", "prefer-fewer-comments");
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  if (outputs.length === 0) {
    if (!request.tools.some((tool) => tool.name === "exec_command")) throw new OpenAiProtocolError("$.tools", "exec_command is unavailable", "prefer-fewer-comments");
    const heredoc = `cat > target.py <<'HARNESS_COMMENTS'\n${TARGET_CONTENT}HARNESS_COMMENTS`;
    const command = process.platform === "win32" ? `@'\n${heredoc}\n'@ | bash` : heredoc;
    return {
      scenario: "prefer-fewer-comments", checkpoint: "comment-heavy-write",
      output: {
        type: "function_call", id: "fc_e2e_prefer_fewer_comments_write", call_id: CODEX_WRITE_ID,
        name: "exec_command", status: "completed", arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 }),
      },
    };
  }
  if (!hasBudgetReminder(allText)) throw new OpenAiProtocolError("$.input", "shell write did not carry the comment-budget reminder", "prefer-fewer-comments");
  return { scenario: "prefer-fewer-comments", checkpoint: "complete", output: finalOutput(FINAL_MESSAGE) };
}

function hasBudgetReminder(text: string): boolean {
  return text.includes("target.py") && text.includes("more commentary") && text.includes("Budget:") && text.includes("write less") && text.includes("What you already wrote stands");
}

function claudeResult(request: AnthropicMessagesRequest, id: string): Record<string, unknown> | undefined {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) if (isRecord(block) && block.type === "tool_result" && block.tool_use_id === id) return block;
  }
  return undefined;
}

function finalOutput(text: string): OpenAiResponseOutput {
  return { type: "message", id: `msg_${createHash("sha256").update(text).digest("hex").slice(0, 24)}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function deepText(value: unknown): string {
  const strings: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") strings.push(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (isRecord(item)) Object.values(item).forEach(visit);
  };
  visit(value);
  return strings.join("\n");
}

function stableId(checkpoint: string): string {
  return `msg_e2e_${createHash("sha256").update(`prefer-fewer-comments:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
