import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const DRAFT_MARKER = "[E2E:issue-writers:draft]";
export const AGENT_PUBLISH_MARKER = "[E2E:issue-writers:agent-publish]";
export const DRAFT_NAME = "issue-0.md";
export const DRAFT_CONTENT = "# Document deterministic issue journeys\n\n> difficulty:routine, mode:afk\n\n## What to build\n\nExercise the real CLI and fake endpoint through a resumable session.\n\n## Acceptance criteria\n\n- Draft publishing is hook-only.\n";
export const scenarioCatalogHash = createHash("sha256").update("issue-writers:v3").digest("hex");

const CLAUDE_WRITE = "toolu_e2e_issue_writer_write";
const CODEX_WRITE = "call_e2e_issue_writer_write";
const CLAUDE_PUBLISH = "toolu_e2e_issue_writer_publish";
const CODEX_PUBLISH = "call_e2e_issue_writer_publish";

export function claudeTransition(request: AnthropicMessagesRequest, repoRoot: string, publishCommand?: string): AnthropicScenarioResponse {
  const text = deepText(request);
  if (text.includes(AGENT_PUBLISH_MARKER) && publishCommand) {
    const result = resultFor(request, CLAUDE_PUBLISH);
    if (result) {
      requirePublicationResult(result);
      return { scenario: "issue-writers", checkpoint: "agent-published", messageId: stableId("claude:published"), stopReason: "end_turn", content: [{ type: "text", text: "Published the fixture issue." }] };
    }
    if (!request.tools.some(tool => tool.name === "Bash")) throw new E2eProtocolError("$.tools", "Bash is unavailable", "issue-writers");
    return { scenario: "issue-writers", checkpoint: "agent-publish", messageId: stableId("claude:publish"), stopReason: "tool_use", content: [{ type: "tool_use", id: CLAUDE_PUBLISH, name: "Bash", input: { command: publishCommand, timeout: 30_000 } }] };
  }
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

export function codexTransition(request: OpenAiResponsesRequest, repoRoot: string, publishCommand?: string): OpenAiScenarioResponse {
  const text = deepText([request.instructions, request.input]);
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  if (text.includes(AGENT_PUBLISH_MARKER) && publishCommand) {
    const result = outputs.find(item => item.call_id === CODEX_PUBLISH);
    if (result) {
      requirePublicationResult(result);
      return { scenario: "issue-writers", checkpoint: "agent-published", output: finalOutput("Published the fixture issue.") };
    }
    const args = { cmd: publishCommand, yield_time_ms: 10_000, max_output_tokens: 2_000 };
    const output: OpenAiResponseOutput = request.codeMode
      ? { type: "custom_tool_call", id: `ctc_${CODEX_PUBLISH}`, call_id: CODEX_PUBLISH, name: "exec", status: "completed", input: `const result = await tools.exec_command(${JSON.stringify(args)}); text(JSON.stringify(result));` }
      : { type: "function_call", id: `fc_${CODEX_PUBLISH}`, call_id: CODEX_PUBLISH, name: "exec_command", status: "completed", arguments: JSON.stringify(args) };
    return { scenario: "issue-writers", checkpoint: "agent-publish", output };
  }
  const draft = draftPath(text, repoRoot, "$.input", "codex");
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

function requirePublicationResult(result: unknown): void {
  const output = deepText(result);
  if (!output.includes("Published 1 issue(s) successfully.") || !output.includes("https://github.test/fixture/issues/issues/101")) {
    throw new Error("Agent did not receive the successful publication report and issue URL");
  }
}

function writeFileCommand(path: string, content: string): string {
  // mkdir -p first, exactly as a real agent's write tool would, so the draft
  // lands whether or not the hook already created the directory.
  const script = "const fs=require('node:fs'),p=Buffer.from(process.argv[1],'base64').toString();fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(process.argv[2],'base64'))";
  return `node -e \"${script}\" ${Buffer.from(path).toString("base64")} ${Buffer.from(content).toString("base64")}`;
}

export function findDraftPath(text: string, repoRoot: string): string {
  return draftPath(text, repoRoot, "context", "codex");
}

function draftPath(text: string, repoRoot: string, field: string, platform: "claude" | "codex"): string {
  // The hook allocates the concrete next path for this saved conversation.
  const match = /draft file path:\s+([^\s]+)/iu.exec(text);
  const allocated = match?.[1];
  if (allocated && /^\.harness\/issue-drafts\/[0-9a-f-]{36}\.issue-\d+\.md$/iu.test(allocated)) {
    const candidate = normalize(join(repoRoot, allocated));
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
