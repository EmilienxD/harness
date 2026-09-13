import { createHash } from "node:crypto";
import { type AnthropicMessagesRequest, type AnthropicScenarioResponse, E2eProtocolError } from "../../core/anthropic-protocol.js";
import { type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse, OpenAiProtocolError } from "../../core/openai-server.js";

export const MARKER = "[E2E:usage-limit-wait]";
export const FINAL_MESSAGE = "The turn continued after the usage limit was restored.";
export const scenarioCatalogHash = createHash("sha256").update("usage-limit-wait:v1").digest("hex");

export function claudeTransition(request: AnthropicMessagesRequest): AnthropicScenarioResponse {
  if (!deepText(request.messages).includes(MARKER)) throw new E2eProtocolError("$.messages", "does not select the scenario", "usage-limit-wait");
  return { scenario: "usage-limit-wait", checkpoint: "complete", messageId: stableId("claude"), stopReason: "end_turn", content: [{ type: "text", text: FINAL_MESSAGE }] };
}

export function codexTransition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
  if (!deepText(request.input).includes(MARKER)) throw new OpenAiProtocolError("$.input", "does not select the scenario", "usage-limit-wait");
  const output: OpenAiResponseOutput = { type: "message", id: stableId("codex"), role: "assistant", status: "completed", content: [{ type: "output_text", text: FINAL_MESSAGE, annotations: [] }] };
  return { scenario: "usage-limit-wait", checkpoint: "complete", output };
}

function deepText(value: unknown): string {
  const parts: string[] = [];
  const visit = (item: unknown): void => { if (typeof item === "string") parts.push(item); else if (Array.isArray(item)) item.forEach(visit); else if (typeof item === "object" && item !== null) Object.values(item).forEach(visit); };
  visit(value); return parts.join("\n");
}
function stableId(platform: string): string { return `msg_e2e_${createHash("sha256").update(`usage-limit-wait:${platform}`).digest("hex").slice(0, 20)}`; }
