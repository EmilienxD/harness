import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const DRAFT_MARKER = "[E2E:issue-writers:draft]";
export const DRAFT_NAME = "issue-0.md";
export const DRAFT_CONTENT = "# Document deterministic issue journeys\n\n> difficulty:routine, mode:afk\n\n## What to build\n\nExercise the real CLI and fake endpoint through a resumable session.\n\n## Acceptance criteria\n\n- Draft publishing is hook-only.\n";
export const scenarioCatalogHash = createHash("sha256").update("issue-writers:v1").digest("hex");

const CLAUDE_WRITE = "toolu_e2e_issue_writer_write";
const CODEX_WRITE = "call_e2e_issue_writer_write";

export function claudeTransition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const text = deepText(request);
  requireDraftContext(text, "$.messages", "claude");
  const draft = draftPath(text, repoRoot, "$.messages", "claude");
  if (!request.tools.some((tool) => tool.name === "Write")) throw new E2eProtocolError("$.tools", "Write is unavailable", "issue-writers");
  if (resultFor(request, CLAUDE_WRITE) === undefined) {
    return {
      scenario: "issue-writers", checkpoint: "draft-write", messageId: stableId("claude:write"), stopReason: "tool_use",
      content: [{ type: "tool_use", id: CLAUDE_WRITE, name: "Write", input: { file_path: draft, content: DRAFT_CONTENT } }],
    };
  }
  requireDraftBytes(draft, "$.messages", "claude");
  return {
    scenario: "issue-writers", checkpoint: "draft-complete", messageId: stableId("claude:complete"), stopReason: "end_turn",
    content: [{ type: "text", text: "Drafted the issue for review; resume this session to publish it." }],
  };
}

export function codexTransition(request: OpenAiResponsesRequest, repoRoot: string): OpenAiScenarioResponse {
  const text = deepText([request.instructions, request.input]);
  requireDraftContext(text, "$.input", "codex");
  const draft = draftPath(text, repoRoot, "$.input", "codex");
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  if (!outputs.some((item) => item.call_id === CODEX_WRITE)) {
    const relativeDraft = relative(repoRoot, draft).replaceAll("\\", "/");
    const patch = `*** Begin Patch\n*** Add File: ${relativeDraft}\n${DRAFT_CONTENT.split("\n").slice(0, -1).map((line) => `+${line}`).join("\n")}\n*** End Patch`;
    const output: OpenAiResponseOutput = request.codeMode
      ? { type: "custom_tool_call", id: `ctc_${CODEX_WRITE}`, call_id: CODEX_WRITE, name: "exec", status: "completed", input: `const result = await tools.apply_patch(${JSON.stringify(patch)}); text(JSON.stringify(result));` }
      : { type: "function_call", id: `fc_${CODEX_WRITE}`, call_id: CODEX_WRITE, name: "exec_command", status: "completed", arguments: JSON.stringify({ cmd: writeFileCommand(relativeDraft, DRAFT_CONTENT), yield_time_ms: 10_000, max_output_tokens: 2_000 }) };
    return {
      scenario: "issue-writers", checkpoint: "draft-write",
      output,
    };
  }
  requireDraftBytes(draft, "$.input", "codex");
  return { scenario: "issue-writers", checkpoint: "draft-complete", output: finalOutput("Drafted the issue for review; resume this session to publish it.") };
}

function writeFileCommand(path: string, content: string): string {
  const script = "require('node:fs').writeFileSync(Buffer.from(process.argv[1],'base64').toString(),Buffer.from(process.argv[2],'base64'))";
  return `node -e \"${script}\" ${Buffer.from(path).toString("base64")} ${Buffer.from(content).toString("base64")}`;
}

export function findDraftPath(text: string, repoRoot: string): string {
  return draftPath(text, repoRoot, "context", "codex");
}

function requireDraftContext(text: string, field: string, platform: "claude" | "codex"): void {
  const valid = text.includes(DRAFT_MARKER)
    && text.includes("Issues gateway drafting context:")
    && text.includes("next free issue index: 0")
    && text.includes("gateway handles publishing")
    && text.includes("not allowed to call `gh issue create`");
  if (valid) return;
  if (platform === "claude") throw new E2eProtocolError(field, "draft-issue instructions or hook context are missing", "issue-writers");
  throw new OpenAiProtocolError(field, "draft-issue instructions or hook context are missing", "issue-writers");
}

function draftPath(text: string, repoRoot: string, field: string, platform: "claude" | "codex"): string {
  const match = /draft directory:\s+([^\s]+)/u.exec(text);
  const relativePath = match?.[1];
  if (relativePath && /^\.issues-gateway\/[0-9a-f-]{36}$/iu.test(relativePath)) {
    const candidate = normalize(join(repoRoot, relativePath, DRAFT_NAME));
    const outside = relative(repoRoot, candidate);
    if (!outside.startsWith("..") && !isAbsolute(outside)) return candidate;
  }
  if (platform === "claude") throw new E2eProtocolError(field, "hook supplied an invalid draft directory", "issue-writers");
  throw new OpenAiProtocolError(field, "hook supplied an invalid draft directory", "issue-writers");
}

function requireDraftBytes(path: string, field: string, platform: "claude" | "codex"): void {
  if (readFileSync(path, "utf8").replaceAll("\r\n", "\n") === DRAFT_CONTENT) return;
  if (platform === "claude") throw new E2eProtocolError(field, "Write did not produce the expected draft", "issue-writers");
  throw new OpenAiProtocolError(field, "write did not produce the expected draft", "issue-writers");
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
  return { type: "message", id: stableId(`codex:${text}`), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
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
  return `msg_e2e_${createHash("sha256").update(`issue-writers:${value}`).digest("hex").slice(0, 20)}`;
}
