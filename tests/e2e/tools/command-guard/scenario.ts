import { createHash } from "node:crypto";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const MARKER = "[E2E:command-guard]";
export const FINAL_MESSAGE = "command-guard denied the dangerous command after allowing the safe command.";
export const SAFE_COMMAND = `node -e "require('node:fs').writeFileSync('allowed.txt','allowed\\n')"`;
export const DANGEROUS_COMMAND = `git push --force origin main; node -e "require('node:fs').writeFileSync('denied.txt','denied\\n')"`;
export const scenarioCatalogHash = createHash("sha256").update("command-guard:v1").digest("hex");

const CLAUDE_SAFE_ID = "toolu_e2e_command_guard_safe";
const CLAUDE_DANGEROUS_ID = "toolu_e2e_command_guard_dangerous";
const CODEX_SAFE_ID = "call_e2e_command_guard_safe";
const CODEX_DANGEROUS_ID = "call_e2e_command_guard_dangerous";

export function claudeTransition(request: AnthropicMessagesRequest): AnthropicScenarioResponse {
  if (!deepText(request.messages).includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "command-guard");
  const safe = claudeResult(request, CLAUDE_SAFE_ID);
  if (safe === undefined) {
    if (!request.tools.some((tool) => tool.name === "Bash")) throw new E2eProtocolError("$.tools", "Bash is unavailable", "command-guard");
    return toolUse("safe-command", CLAUDE_SAFE_ID, SAFE_COMMAND);
  }
  if (safe.is_error === true) throw new E2eProtocolError("$.messages", "safe command was denied", "command-guard");
  const dangerous = claudeResult(request, CLAUDE_DANGEROUS_ID);
  if (dangerous === undefined) return toolUse("dangerous-command-denied", CLAUDE_DANGEROUS_ID, DANGEROUS_COMMAND);
  assertDenial(deepText(dangerous), dangerous.is_error, "$.messages", "claude");
  return { scenario: "command-guard", checkpoint: "complete", messageId: stableId("complete"), stopReason: "end_turn", content: [{ type: "text", text: FINAL_MESSAGE }] };
}

export function codexTransition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
  if (!deepText(request.input).includes(MARKER)) throw new OpenAiProtocolError("$.input", "does not select the scenario", "command-guard");
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  if (outputs.length === 0) return { scenario: "command-guard", checkpoint: "safe-command", output: codexCall(request, CODEX_SAFE_ID, SAFE_COMMAND, "safe") };
  if (outputs.length === 1) return { scenario: "command-guard", checkpoint: "dangerous-command-denied", output: codexCall(request, CODEX_DANGEROUS_ID, DANGEROUS_COMMAND, "dangerous") };
  assertDenial(deepText(outputs.at(-1)), undefined, "$.input", "codex");
  return { scenario: "command-guard", checkpoint: "complete", output: finalOutput(FINAL_MESSAGE) };
}

function toolUse(checkpoint: string, id: string, command: string): AnthropicScenarioResponse {
  return { scenario: "command-guard", checkpoint, messageId: stableId(checkpoint), stopReason: "tool_use", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] };
}

function codexCall(request: OpenAiResponsesRequest, callId: string, command: string, suffix: string): OpenAiResponseOutput {
  return request.codeMode
    ? { type: "custom_tool_call", id: `ctc_e2e_command_guard_${suffix}`, call_id: callId, name: "exec", status: "completed", input: `const result = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 })}); text(JSON.stringify(result));` }
    : { type: "function_call", id: `fc_e2e_command_guard_${suffix}`, call_id: callId, name: "exec_command", status: "completed", arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 }) };
}

function assertDenial(text: string, isError: unknown, path: string, provider: "claude" | "codex"): void {
  if ((provider === "claude" && isError !== true) || !/blocked|denied|permission/iu.test(text) || !/command-guard|force push/iu.test(text)) {
    const ErrorType = provider === "claude" ? E2eProtocolError : OpenAiProtocolError;
    throw new ErrorType(path, "dangerous command was not denied by command-guard", "command-guard");
  }
}

function claudeResult(request: AnthropicMessagesRequest, id: string): Record<string, unknown> | undefined {
  for (const message of request.messages) if (Array.isArray(message.content)) for (const block of message.content) {
    if (isRecord(block) && block.type === "tool_result" && block.tool_use_id === id) return block;
  }
  return undefined;
}

function finalOutput(text: string): OpenAiResponseOutput {
  return { type: "message", id: `msg_${createHash("sha256").update(text).digest("hex").slice(0, 24)}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function deepText(value: unknown): string {
  const strings: string[] = [];
  const visit = (item: unknown): void => { if (typeof item === "string") strings.push(item); else if (Array.isArray(item)) item.forEach(visit); else if (typeof item === "object" && item !== null) Object.values(item).forEach(visit); };
  visit(value);
  return strings.join("\n");
}

function stableId(checkpoint: string): string {
  return `msg_e2e_${createHash("sha256").update(`command-guard:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
