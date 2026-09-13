import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const REVIEW_MARKER = "[E2E:issue-readers:review]";
export const REVIEW_MESSAGE = "Reviewed the issue 42 commit and found no remaining changes.";
export const scenarioCatalogHash = createHash("sha256").update("issue-readers:v1").digest("hex");

const FILE = "implementation.txt";
const CONTENT = "addressed issue 42\n";
const COMMIT = "Address fixture issue 42";
const CLAUDE_READ = "toolu_e2e_issue_reader_read";
const CLAUDE_WRITE = "toolu_e2e_issue_reader_write";
const CLAUDE_STAGE = "toolu_e2e_issue_reader_stage";
const CLAUDE_COMMIT = "toolu_e2e_issue_reader_commit";
const CODEX_READ = "call_e2e_issue_reader_read";
const CODEX_WRITE = "call_e2e_issue_reader_write";
const CODEX_STAGE = "call_e2e_issue_reader_stage";
const CODEX_COMMIT = "call_e2e_issue_reader_commit";

export function claudeTransition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  const text = deepText(request);
  if (text.includes(REVIEW_MARKER)) {
    requireReviewContext(text, "$.messages", "claude");
    return response("review-complete", "end_turn", [{ type: "text", text: REVIEW_MESSAGE }]);
  }
  if (!text.includes("address-this")) throw new E2eProtocolError("$.messages", "does not select an issue-readers scenario", "issue-readers");
  requireAddressContext(text, "$.messages", "claude");
  for (const name of ["Read", "Edit", "Bash"]) {
    if (!request.tools.some((tool) => tool.name === name)) throw new E2eProtocolError("$.tools", `${name} is unavailable`, "issue-readers");
  }
  const read = resultFor(request, CLAUDE_READ);
  if (read === undefined) {
    return response("address-read", "tool_use", [{ type: "tool_use", id: CLAUDE_READ, name: "Read", input: { file_path: join(repoRoot, FILE) } }]);
  }
  if (read.is_error === true || !deepText(read).includes("before")) throw new E2eProtocolError("$.messages", "Read did not return the fixture baseline", "issue-readers");
  if (resultFor(request, CLAUDE_WRITE) === undefined) {
    return response("address-write", "tool_use", [{ type: "tool_use", id: CLAUDE_WRITE, name: "Edit", input: { file_path: join(repoRoot, FILE), old_string: "before", new_string: CONTENT.trimEnd(), replace_all: false } }]);
  }
  requireFile(repoRoot, "$.messages", "claude");
  if (resultFor(request, CLAUDE_STAGE) === undefined) {
    return response("address-stage", "tool_use", [{ type: "tool_use", id: CLAUDE_STAGE, name: "Bash", input: { command: `git add -- ${FILE}`, description: "Stage the issue change" } }]);
  }
  if (resultFor(request, CLAUDE_COMMIT) === undefined) {
    return response("address-commit", "tool_use", [{ type: "tool_use", id: CLAUDE_COMMIT, name: "Bash", input: { command: `git commit -m \"${COMMIT}\"`, description: "Commit the issue change" } }]);
  }
  return response("address-complete", "end_turn", [{ type: "text", text: "Addressed issue 42 and committed the verified change." }]);
}

export function codexTransition(request: OpenAiResponsesRequest, repoRoot: string): OpenAiScenarioResponse {
  const text = deepText([request.instructions, request.input]);
  if (text.includes(REVIEW_MARKER)) {
    requireReviewContext(text, "$.input", "codex");
    return { scenario: "issue-readers", checkpoint: "review-complete", output: finalOutput(REVIEW_MESSAGE) };
  }
  if (!text.includes("address-this")) throw new OpenAiProtocolError("$.input", "does not select an issue-readers scenario", "issue-readers");
  requireAddressContext(text, "$.input", "codex");
  const outputs = toolOutputs(request);
  if (!outputs.some((item) => item.call_id === CODEX_READ)) {
    return { scenario: "issue-readers", checkpoint: "address-read", output: commandCall(request, CODEX_READ, `git show HEAD:${FILE}`) };
  }
  if (!text.includes("before")) throw new OpenAiProtocolError("$.input", "read command did not return the fixture baseline", "issue-readers");
  if (!outputs.some((item) => item.call_id === CODEX_WRITE)) {
    return { scenario: "issue-readers", checkpoint: "address-write", output: commandCall(request, CODEX_WRITE, writeFileCommand(FILE, CONTENT)) };
  }
  requireFile(repoRoot, "$.input", "codex");
  if (!outputs.some((item) => item.call_id === CODEX_STAGE)) {
    return { scenario: "issue-readers", checkpoint: "address-stage", output: commandCall(request, CODEX_STAGE, `git add -- ${FILE}`) };
  }
  if (!outputs.some((item) => item.call_id === CODEX_COMMIT)) {
    return { scenario: "issue-readers", checkpoint: "address-commit", output: commandCall(request, CODEX_COMMIT, `git commit -m \"${COMMIT}\"`) };
  }
  return { scenario: "issue-readers", checkpoint: "address-complete", output: finalOutput("Addressed issue 42 and committed the verified change.") };
}

function requireAddressContext(text: string, field: string, platform: "claude" | "codex"): void {
  const checks = {
    header: text.includes("Address-this context, prepared by a hook from GitHub"),
    issue: text.includes("Issue fixture/issues#42: Address the deterministic fixture"),
    comment: text.includes("Keep the final file to one line."),
    markerStripped: !text.includes("issues-gateway:legacy"),
  };
  const valid = Object.values(checks).every(Boolean);
  const missing = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(", ");
  if (!valid) throw platform === "claude"
    ? new E2eProtocolError(field, `address-this context checks failed: ${missing}`, "issue-readers")
    : new OpenAiProtocolError(field, `address-this context checks failed: ${missing}`, "issue-readers");
}

function requireReviewContext(text: string, field: string, platform: "claude" | "codex"): void {
  const checks = {
    header: text.includes("Review-this context, prepared by a hook from the local repository"),
    file: text.includes("implementation.txt"),
  };
  const valid = Object.values(checks).every(Boolean);
  const missing = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(", ");
  if (!valid) throw platform === "claude"
    ? new E2eProtocolError(field, `review-this context checks failed: ${missing}`, "issue-readers")
    : new OpenAiProtocolError(field, `review-this context checks failed: ${missing}`, "issue-readers");
}

function requireFile(repoRoot: string, field: string, platform: "claude" | "codex"): void {
  if (readFileSync(join(repoRoot, FILE), "utf8") === CONTENT) return;
  if (platform === "claude") throw new E2eProtocolError(field, "write tool did not create the expected bytes", "issue-readers");
  throw new OpenAiProtocolError(field, "write tool did not create the expected bytes", "issue-readers");
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

function toolOutputs(request: OpenAiResponsesRequest): readonly Record<string, unknown>[] {
  return request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
}

function response(checkpoint: string, stopReason: "tool_use" | "end_turn", content: readonly Record<string, unknown>[]): AnthropicScenarioResponse {
  return { scenario: "issue-readers", checkpoint, messageId: stableId(`claude:${checkpoint}`), stopReason, content };
}

function commandCall(request: OpenAiResponsesRequest, callId: string, command: string): OpenAiResponseOutput {
  const args = { cmd: command, yield_time_ms: 10_000, max_output_tokens: 2_000 };
  if (!request.codeMode) return { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "exec_command", status: "completed", arguments: JSON.stringify(args) };
  return customCall(callId, `const result = await tools.exec_command(${JSON.stringify(args)}); text(result.output);`);
}

function customCall(callId: string, input: string): OpenAiResponseOutput {
  return { type: "custom_tool_call", id: `ctc_${callId}`, call_id: callId, name: "exec", status: "completed", input };
}

function writeFileCommand(path: string, content: string): string {
  const script = "require('node:fs').writeFileSync(Buffer.from(process.argv[1],'base64').toString(),Buffer.from(process.argv[2],'base64'))";
  return `node -e \"${script}\" ${Buffer.from(path).toString("base64")} ${Buffer.from(content).toString("base64")}`;
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
  return `msg_e2e_${createHash("sha256").update(`issue-readers:${value}`).digest("hex").slice(0, 20)}`;
}
