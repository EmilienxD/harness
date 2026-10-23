import { createHash } from "node:crypto";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const MARKER = "[E2E:report-gotchas]";
export const REPORT_MARKER = "REPORT-GOTCHAS-LIVE-E2E";
export const FINAL_MESSAGE = "Discord report delivered through the report-gotchas skill.";
export const scenarioCatalogHash = createHash("sha256").update("report-gotchas:v2").digest("hex");

const CLAUDE_SKILL_ID = "toolu_e2e_report_gotchas_skill";
const CLAUDE_SUBMIT_ID = "toolu_e2e_report_gotchas_submit";
const CODEX_READ_ID = "call_e2e_report_gotchas_read";
const CODEX_SUBMIT_ID = "call_e2e_report_gotchas_submit";

export function claudeTransition(request: AnthropicMessagesRequest, submitCommand: string): AnthropicScenarioResponse {
  const text = deepText(request.messages);
  if (!text.includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "report-gotchas");
  for (const name of ["Skill", "Bash"]) {
    if (!request.tools.some((tool) => tool.name === name)) throw new E2eProtocolError("$.tools", `required tool ${name} is unavailable`, "report-gotchas");
  }
  const skill = resultFor(request, CLAUDE_SKILL_ID);
  if (skill === undefined) {
    return {
      scenario: "report-gotchas", checkpoint: "skill-loaded", messageId: stableId("claude-skill"), stopReason: "tool_use",
      content: [{ type: "tool_use", id: CLAUDE_SKILL_ID, name: "Skill", input: { skill: "report-gotchas" } }],
    };
  }
  if (skill.is_error === true) throw new E2eProtocolError("$.messages", "Skill invocation failed", "report-gotchas");
  const submitted = resultFor(request, CLAUDE_SUBMIT_ID);
  if (submitted === undefined) {
    return {
      scenario: "report-gotchas", checkpoint: "report-submitted", messageId: stableId("claude-submit"), stopReason: "tool_use",
      content: [{ type: "tool_use", id: CLAUDE_SUBMIT_ID, name: "Bash", input: { command: submitCommand, description: "Report implementation caveat" } }],
    };
  }
  if (submitted.is_error === true || !deepText(submitted).includes("Report successfully posted to Discord."))
    throw new E2eProtocolError("$.messages", "Discord submission was not confirmed", "report-gotchas");
  return {
    scenario: "report-gotchas", checkpoint: "complete", messageId: stableId("claude-complete"), stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_MESSAGE }],
  };
}

export function codexTransition(request: OpenAiResponsesRequest, skillReadCommand: string, submitCommand: string): OpenAiScenarioResponse {
  const text = deepText(request.input);
  if (!text.includes(MARKER)) throw new OpenAiProtocolError("$.input", "does not select the scenario", "report-gotchas");
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  if (!outputs.some(item => item.call_id === CODEX_READ_ID)) {
    return { scenario: "report-gotchas", checkpoint: "skill-loaded", output: codexShellCall(request, CODEX_READ_ID, skillReadCommand) };
  }
  const submitted = outputs.find(item => item.call_id === CODEX_SUBMIT_ID);
  if (!submitted) {
    return { scenario: "report-gotchas", checkpoint: "report-submitted", output: codexShellCall(request, CODEX_SUBMIT_ID, submitCommand) };
  }
  if (!deepText(submitted).includes("Report successfully posted to Discord."))
    throw new OpenAiProtocolError("$.input", "Discord submission was not confirmed", "report-gotchas");
  return { scenario: "report-gotchas", checkpoint: "complete", output: finalOutput(FINAL_MESSAGE) };
}

function codexShellCall(request: OpenAiResponsesRequest, callId: string, command: string): OpenAiResponseOutput {
  if (request.codeMode) {
    const input = `const result = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 4_000 })}); text(result.output);`;
    return { type: "custom_tool_call", id: `ctc_${callId}`, call_id: callId, name: "exec", status: "completed", input };
  }
  return {
    type: "function_call", id: `fc_${callId}`, call_id: callId, name: "exec_command", status: "completed",
    arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 4_000 }),
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

function finalOutput(text: string): OpenAiResponseOutput {
  return { type: "message", id: stableId("codex-complete"), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
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
  return `msg_e2e_${createHash("sha256").update(`report-gotchas:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
