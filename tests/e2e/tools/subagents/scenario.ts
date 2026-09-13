import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { containsPath } from "../../core/path.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const PARENT_MARKER = "HARNESS_SUBAGENTS_PARENT_E2E_91D4";
export const CHILD_MARKER = "HARNESS_SUBAGENTS_CHILD_E2E_7B2A";
export const CHILD_REPLY = "HARNESS_SUBAGENTS_CHILD_COMPLETE_48CF: inspected the delegated task.";
export const PARENT_REPLY = "HARNESS_SUBAGENTS_PARENT_COMPLETE_33A1: received the child reply.";
export const scenarioCatalogHash = createHash("sha256").update("subagents:v1").digest("hex");

const CLAUDE_WRITE_ID = "toolu_e2e_subagents_request";
const CLAUDE_REPLY_ID = "toolu_e2e_subagents_reply";
const CODEX_WRITE_ID = "call_e2e_subagents_request";
const CODEX_REPLY_ID = "call_e2e_subagents_reply";

export function claudeTransition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const text = deepText(request.messages);
  if (text.includes(PARENT_MARKER)) return claudeParent(request, repoRoot, text);
  if (text.includes(CHILD_MARKER)) return claudeChild(request);
  throw new E2eProtocolError("$.messages", "does not select the subagents scenario", "subagents");
}

export function codexTransition(request: OpenAiResponsesRequest, repoRoot: string): OpenAiScenarioResponse {
  const text = deepText([request.instructions, request.input]);
  if (text.includes(PARENT_MARKER)) return codexParent(request, repoRoot, text);
  if (text.includes(CHILD_MARKER)) return codexChild(request);
  throw new OpenAiProtocolError("$.input", "does not select the subagents scenario", "subagents");
}

function claudeParent(request: AnthropicMessagesRequest, repoRoot: string, text: string): AnthropicScenarioResponse {
  const result = claudeResult(request, CLAUDE_WRITE_ID);
  if (result === undefined) {
    const inbox = requireInbox(text, repoRoot, "claude");
    if (!request.tools.some((tool) => tool.name === "Write")) {
      throw new E2eProtocolError("$.tools", "Write is unavailable", "subagents");
    }
    return claudeResponse("parent-request-write", "tool_use", [{
      type: "tool_use",
      id: CLAUDE_WRITE_ID,
      name: "Write",
      input: { file_path: resolve(inbox, "child.md"), content: requestBody() },
    }]);
  }
  if (text.includes(CHILD_REPLY)) {
    return claudeResponse("parent-received-reply", "end_turn", [{ type: "text", text: PARENT_REPLY }]);
  }
  requireRequestFile(text, repoRoot, "claude");
  return claudeResponse("parent-waiting", "end_turn", [{ type: "text", text: "Waiting for the delegated agent." }]);
}

function claudeChild(request: AnthropicMessagesRequest): AnthropicScenarioResponse {
  const result = claudeResult(request, CLAUDE_REPLY_ID);
  if (result === undefined) {
    if (!request.tools.some((tool) => tool.name === "Bash")) {
      throw new E2eProtocolError("$.tools", "Bash is unavailable to arm the child reply", "subagents");
    }
    return claudeResponse("child-reply-armed", "tool_use", [{
      type: "tool_use", id: CLAUDE_REPLY_ID, name: "Bash", input: { command: "harness reply", description: "Reply to the parent agent" },
    }]);
  }
  if (result.is_error === true || !deepText(result).includes("next successful Stop will reply to the parent")) {
    throw new E2eProtocolError("$.messages", "harness reply did not arm the child Stop", "subagents");
  }
  return claudeResponse("child-complete", "end_turn", [{ type: "text", text: CHILD_REPLY }]);
}

function codexParent(request: OpenAiResponsesRequest, repoRoot: string, text: string): OpenAiScenarioResponse {
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  if (!outputs.some((item) => item.call_id === CODEX_WRITE_ID)) {
    const inbox = requireInbox(text, repoRoot, "codex");
    const offered = request.tools.map((tool) => String(tool.name ?? tool.type ?? "unknown"));
    if (!request.codeMode && !offered.includes("exec_command")) {
      throw new OpenAiProtocolError("$.tools", `exec_command is unavailable; offered: ${offered.join(", ")}`, "subagents");
    }
    const requestPath = resolve(inbox, "child.md");
    const grantId = basename(dirname(inbox));
    const command = `harness-e2e-request ${Buffer.from(requestPath).toString("base64")} ${Buffer.from(requestBody()).toString("base64")} ${grantId}`;
    const output: OpenAiResponseOutput = request.codeMode
      ? {
          type: "custom_tool_call",
          id: "ctc_e2e_subagents_request",
          call_id: CODEX_WRITE_ID,
          name: "exec",
          status: "completed",
          input: `const result = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 })}); text(JSON.stringify(result));`,
        }
      : {
          type: "function_call",
          id: "fc_e2e_subagents_request",
          call_id: CODEX_WRITE_ID,
          name: "exec_command",
          status: "completed",
          arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 }),
        };
    return { scenario: "subagents", checkpoint: "parent-request-write", output };
  }
  if (text.includes(CHILD_REPLY)) {
    return { scenario: "subagents", checkpoint: "parent-received-reply", output: finalOutput("parent-received-reply", PARENT_REPLY) };
  }
  requireRequestFile(text, repoRoot, "codex");
  return { scenario: "subagents", checkpoint: "parent-waiting", output: finalOutput("parent-waiting", "Waiting for the delegated agent.") };
}

function codexChild(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  const result = outputs.find((item) => item.call_id === CODEX_REPLY_ID);
  if (result === undefined) {
    const command = "harness reply";
    const output: OpenAiResponseOutput = request.codeMode
      ? {
          type: "custom_tool_call", id: "ctc_e2e_subagents_reply", call_id: CODEX_REPLY_ID, name: "exec", status: "completed",
          input: `const result = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 })}); text(JSON.stringify(result));`,
        }
      : {
          type: "function_call", id: "fc_e2e_subagents_reply", call_id: CODEX_REPLY_ID, name: "exec_command", status: "completed",
          arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 }),
        };
    return { scenario: "subagents", checkpoint: "child-reply-armed", output };
  }
  if (!deepText(result).includes("next successful Stop will reply to the parent")) {
    throw new OpenAiProtocolError("$.input", "harness reply did not arm the child Stop", "subagents");
  }
  return { scenario: "subagents", checkpoint: "child-complete", output: finalOutput("child-complete", CHILD_REPLY) };
}

function requireInbox(text: string, repoRoot: string, provider: "claude" | "codex"): string {
  const match = /Delegation inbox opened\. Write one Markdown file per child directly under:\s*\r?\n([^\r\n]+)\r?\n/u.exec(text);
  const inbox = match?.[1]?.trim();
  if (inbox !== undefined && isAbsolute(inbox) && containsPath(repoRoot, inbox)) return inbox;
  if (provider === "claude") throw new E2eProtocolError("$.messages", "missing a contained delegation inbox", "subagents");
  throw new OpenAiProtocolError("$.input", "missing a contained delegation inbox", "subagents");
}

function requireRequestFile(text: string, repoRoot: string, provider: "claude" | "codex"): void {
  const inbox = requireInbox(text, repoRoot, provider);
  let valid = false;
  let detail = "request file is missing";
  try {
    const observed = readFileSync(resolve(inbox, "child.md"), "utf8");
    valid = observed === requestBody();
    detail = `request file has ${Buffer.byteLength(observed)} bytes instead of ${Buffer.byteLength(requestBody())}`;
  } catch { }
  if (valid) return;
  if (provider === "claude") throw new E2eProtocolError("$.messages", detail, "subagents");
  throw new OpenAiProtocolError("$.input", detail, "subagents");
}

function requestBody(): string {
  return `---\ntask: general\nmode: interactive\n---\n\n${CHILD_MARKER}\nInspect the deterministic delegated task and explicitly reply to the parent.\n`;
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

function claudeResponse(checkpoint: string, stopReason: "tool_use" | "end_turn", content: readonly Record<string, unknown>[]): AnthropicScenarioResponse {
  return { scenario: "subagents", checkpoint, messageId: stableId(`claude:${checkpoint}`), stopReason, content };
}

function finalOutput(checkpoint: string, text: string): OpenAiResponseOutput {
  return { type: "message", id: stableId(`codex:${checkpoint}`), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
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

function stableId(value: string): string {
  return `msg_e2e_${createHash("sha256").update(`subagents:${value}`).digest("hex").slice(0, 20)}`;
}
