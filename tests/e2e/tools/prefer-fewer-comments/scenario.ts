import { createHash } from "node:crypto";
import { join } from "node:path";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export type Platform = "claude" | "chatgpt";
export type Method = "native" | "shell" | "printf";
export const MARKER = "[E2E:prefer-fewer-comments]";
export const TARGET = "sample.py";
export const CONTENT = "# one\n# two\n# three\n# four\n# five\nvalue = 1\n";
export const scenarioCatalogHash = createHash("sha256").update("prefer-fewer-comments:v1").digest("hex");

const CLAUDE_CALL = "toolu_e2e_prefer_fewer_comments";
const CODEX_CALL = "call_e2e_prefer_fewer_comments";

export function claudeTransition(request: AnthropicMessagesRequest, root: string, method: Method): AnthropicScenarioResponse {
  const all = deepText(request.messages);
  if (!all.includes(MARKER)) throw new E2eProtocolError("$.messages", "scenario marker missing", "prefer-fewer-comments");
  const result = claudeResult(request);
  if (result === undefined) {
    const tool = method === "native" ? "Write" : "Bash";
    if (!request.tools.some((item) => item.name === tool)) throw new E2eProtocolError("$.tools", `${tool} unavailable`, "prefer-fewer-comments");
    const input = method === "native"
      ? { file_path: join(root, TARGET), content: CONTENT }
      : { command: method === "shell" ? `cat <<'EOF' > ${TARGET}\n${CONTENT}EOF` : `printf '# one\\n# two\\n# three\\n# four\\n# five\\nvalue = 1\\n' > ${TARGET}`, description: "Write the fixture" };
    return { scenario: "prefer-fewer-comments", checkpoint: "write", messageId: stableId(`claude:${method}:write`), stopReason: "tool_use", content: [{ type: "tool_use", id: CLAUDE_CALL, name: tool, input }] };
  }
  if (result.is_error === true || !all.includes("5-line comment") || !all.includes("budget 2")) {
    throw new E2eProtocolError("$.messages", "post-write comment finding was not delivered", "prefer-fewer-comments");
  }
  return { scenario: "prefer-fewer-comments", checkpoint: "reminder", messageId: stableId(`claude:${method}:reminder`), stopReason: "end_turn", content: [{ type: "text", text: "The comment budget reminder was received." }] };
}

export function codexTransition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
  const all = deepText([request.instructions, request.input]);
  if (!all.includes(MARKER)) throw new OpenAiProtocolError("$.input", "scenario marker missing", "prefer-fewer-comments");
  const result = request.input.find((item) => (item.type === "custom_tool_call_output" || item.type === "function_call_output") && item.call_id === CODEX_CALL);
  if (result === undefined) {
    const command = `Set-Content -LiteralPath ${TARGET} -Value @('# one','# two','# three','# four','# five','value = 1')`;
    const output: OpenAiResponseOutput = request.tools.some((item) => item.name === "exec")
      ? { type: "custom_tool_call", id: `ctc_${CODEX_CALL}`, call_id: CODEX_CALL, name: "exec", status: "completed", input: `const result = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 })}); text(result.output);` }
      : { type: "function_call", id: `fc_${CODEX_CALL}`, call_id: CODEX_CALL, name: "exec_command", status: "completed", arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 }) };
    return { scenario: "prefer-fewer-comments", checkpoint: "write", output };
  }
  if (!all.includes("5-line comment") || !all.includes("budget 2")) throw new OpenAiProtocolError("$.input", "post-write comment finding was not delivered", "prefer-fewer-comments");
  return { scenario: "prefer-fewer-comments", checkpoint: "reminder", output: { type: "message", id: stableId("codex:shell:reminder"), role: "assistant", status: "completed", content: [{ type: "output_text", text: "The comment budget reminder was received.", annotations: [] }] } };
}

function claudeResult(request: AnthropicMessagesRequest): Record<string, unknown> | undefined {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) if (isRecord(block) && block.type === "tool_result" && block.tool_use_id === CLAUDE_CALL) return block;
  }
  return undefined;
}

function deepText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(deepText).join("\n");
  if (isRecord(value)) return Object.values(value).map(deepText).join("\n");
  return "";
}

function stableId(step: string): string { return `msg_e2e_${createHash("sha256").update(step).digest("hex").slice(0, 20)}`; }
