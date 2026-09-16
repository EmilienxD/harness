import { createHash } from "node:crypto";
import { join } from "node:path";
import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const FIXTURE_FILE = "retry-imports.txt";
export const FIXTURE_CONTENT = "Imports are retried by uploading the source file again.\n";
export const REPORT = "Retries currently require another upload. I recommend preserving the source and exposing a retry action. How long should we retain the source, and who may retry?";
export const scenarioCatalogHash = createHash("sha256").update("breakdown-help-wanted-issue:v1").digest("hex");
const CLAUDE_READ = "toolu_e2e_breakdown_read";
const CODEX_READ = "call_e2e_breakdown_read";

export function claudeTransition(request: AnthropicMessagesRequest, repoRoot: string): AnthropicScenarioResponse {
  if (!request.tools.some((tool) => tool.name === "Read")) throw new E2eProtocolError("$.tools", "Read is unavailable", "breakdown-help-wanted-issue");
  const result = resultFor(request, CLAUDE_READ);
  if (result === undefined) return response("inspect-current-behavior", "tool_use", [{ type: "tool_use", id: CLAUDE_READ, name: "Read", input: { file_path: `${repoRoot}/${FIXTURE_FILE}` } }]);
  if (result.is_error === true || !deepText(result).includes(FIXTURE_CONTENT.trim())) throw new E2eProtocolError("$.messages", "Read did not return the fixture evidence", "breakdown-help-wanted-issue");
  return response("report-complete", "end_turn", [{ type: "text", text: REPORT }]);
}

export function codexTransition(request: OpenAiResponsesRequest, repoRoot: string): OpenAiScenarioResponse {
  const text = deepText([request.instructions, request.input]);
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  if (!outputs.some((item) => item.call_id === CODEX_READ)) {
    const fixturePath = Buffer.from(join(repoRoot, FIXTURE_FILE), "utf8").toString("base64");
    const readScript = "const fs=require('node:fs'),p=Buffer.from(process.argv[1],'base64').toString('utf8');process.stdout.write(fs.readFileSync(p,'utf8'))";
    const args = { cmd: `node -e \"${readScript}\" ${fixturePath}`, workdir: repoRoot, yield_time_ms: 10_000, max_output_tokens: 2_000 };
    const output: OpenAiResponseOutput = request.codeMode
      ? { type: "custom_tool_call", id: `ctc_${CODEX_READ}`, call_id: CODEX_READ, name: "exec", status: "completed", input: `const result = await tools.exec_command(${JSON.stringify(args)}); text(result.output);` }
      : { type: "function_call", id: `fc_${CODEX_READ}`, call_id: CODEX_READ, name: "exec_command", status: "completed", arguments: JSON.stringify(args) };
    return { scenario: "breakdown-help-wanted-issue", checkpoint: "inspect-current-behavior", output };
  }
  if (!text.includes(FIXTURE_CONTENT.trim())) throw new OpenAiProtocolError("$.input", "read command did not return the fixture evidence", "breakdown-help-wanted-issue");
  return { scenario: "breakdown-help-wanted-issue", checkpoint: "report-complete", output: finalOutput(REPORT) };
}

function resultFor(request: AnthropicMessagesRequest, id: string): Record<string, unknown> | undefined { for (const message of request.messages) if (Array.isArray(message.content)) for (const block of message.content) if (isRecord(block) && block.type === "tool_result" && block.tool_use_id === id) return block; return undefined; }
function response(checkpoint: string, stopReason: "tool_use" | "end_turn", content: readonly Record<string, unknown>[]): AnthropicScenarioResponse { return { scenario: "breakdown-help-wanted-issue", checkpoint, messageId: stableId(`claude:${checkpoint}`), stopReason, content }; }
function finalOutput(text: string): OpenAiResponseOutput { return { type: "message", id: stableId("codex:report"), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }; }
function deepText(value: unknown): string { const strings: string[] = []; const visit = (item: unknown): void => { if (typeof item === "string") strings.push(item); else if (Array.isArray(item)) item.forEach(visit); else if (typeof item === "object" && item !== null) Object.values(item).forEach(visit); }; visit(value); return strings.join("\n"); }
function stableId(value: string): string { return `msg_e2e_${createHash("sha256").update(`breakdown:${value}`).digest("hex").slice(0, 20)}`; }
