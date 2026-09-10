import { createHash } from "node:crypto";
import { join } from "node:path";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const MARKER = "[E2E:no-new-documents]";
export const DOCUMENT = "nested/docs/proposal.md";
export const FINAL_MESSAGE = `Should I add ${DOCUMENT}? I wanted to add it because the task called for a durable proposal.`;
export const scenarioCatalogHash = createHash("sha256").update("no-new-documents:v1").digest("hex");

const CLAUDE_CALL_ID = "toolu_e2e_no_new_documents";
const CODEX_CALL_ID = "call_e2e_no_new_documents";

export function claudeTransition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const text = deepText(request.messages);
  if (!text.includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "no-new-documents");
  const result = claudeResult(request, CLAUDE_CALL_ID);
  if (result === undefined) {
    if (!request.tools.some((tool) => tool.name === "Write")) throw new E2eProtocolError("$.tools", "Write is unavailable", "no-new-documents");
    return {
      scenario: "no-new-documents", checkpoint: "create-denied", messageId: stableId("claude-create"), stopReason: "tool_use",
      content: [{ type: "tool_use", id: CLAUDE_CALL_ID, name: "Write", input: { file_path: join(repoRoot, DOCUMENT), content: "# Proposal\n" } }],
    };
  }
  const denial = deepText(result);
  if (result.is_error !== true || !denial.includes("not authorized") || !denial.includes("final response") || !denial.includes(DOCUMENT)) {
    throw new E2eProtocolError("$.messages", "creation was not denied with actionable feedback", "no-new-documents");
  }
  return {
    scenario: "no-new-documents", checkpoint: "complete", messageId: stableId("claude-complete"), stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_MESSAGE }],
  };
}

export function codexTransition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
  const text = deepText(request.input);
  if (!text.includes(MARKER)) throw new OpenAiProtocolError("$.input", "does not select the scenario", "no-new-documents");
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  if (outputs.length === 0) {
    const output: OpenAiResponseOutput = request.codeMode
      ? {
          type: "custom_tool_call", id: "ctc_e2e_no_new_documents", call_id: CODEX_CALL_ID,
          name: "exec", status: "completed",
          input: `const result = await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${DOCUMENT}\n+# Proposal\n*** End Patch`)}); text(JSON.stringify(result));`,
        }
      : {
          type: "function_call", id: "fc_e2e_no_new_documents", call_id: CODEX_CALL_ID,
          name: "exec_command", status: "completed",
          arguments: JSON.stringify({ cmd: `Write-Output '# Proposal' > ${DOCUMENT}`, yield_time_ms: 10_000, max_output_tokens: 1_000 }),
        };
    return { scenario: "no-new-documents", checkpoint: "create-denied", output };
  }
  const denial = deepText(outputs.at(-1));
  if (!/not authorized|blocked|denied/iu.test(denial) || !denial.includes(DOCUMENT) || !denial.includes("final response")) {
    throw new OpenAiProtocolError("$.input", "creation was not denied with actionable feedback", "no-new-documents");
  }
  return { scenario: "no-new-documents", checkpoint: "complete", output: finalOutput(FINAL_MESSAGE) };
}

function claudeResult(request: AnthropicMessagesRequest, id: string): Record<string, unknown> | undefined {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_result" && block.tool_use_id === id) return block;
    }
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
    else if (typeof item === "object" && item !== null) Object.values(item).forEach(visit);
  };
  visit(value);
  return strings.join("\n");
}

function stableId(checkpoint: string): string {
  return `msg_e2e_${createHash("sha256").update(checkpoint).digest("hex").slice(0, 20)}`;
}
