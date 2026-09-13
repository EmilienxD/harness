import { createHash } from "node:crypto";

import {
  E2eProtocolError,
  type AnthropicMessagesRequest,
  type AnthropicScenarioResponse,
} from "../../core/anthropic-protocol.js";
import {
  OpenAiProtocolError,
  type OpenAiResponseOutput,
  type OpenAiResponsesRequest,
  type OpenAiScenarioResponse,
} from "../../core/openai-server.js";

export const MARKER = "[E2E:agent-launcher]";
export const SYSTEM_PROMPT_MARKER = "[E2E:agent-launcher:system-prompt]";
export const CLAUDE_MODEL = "claude-agent-launcher-e2e";
export const CODEX_MODEL = "codex-agent-launcher-e2e";
export const scenarioCatalogHash = createHash("sha256").update("agent-launcher:v1").digest("hex");

export function claudeTransition(request: AnthropicMessagesRequest): AnthropicScenarioResponse {
  if (!deepText(request.messages).includes(MARKER)) {
    throw new E2eProtocolError("$.messages", "does not select the scenario", "agent-launcher");
  }
  if (request.model !== CLAUDE_MODEL) {
    throw new E2eProtocolError("$.model", "does not contain the launcher-configured model", "agent-launcher");
  }
  if (!deepText(request.system).includes(SYSTEM_PROMPT_MARKER)) {
    throw new E2eProtocolError("$.system", "does not contain the launcher-configured system prompt", "agent-launcher");
  }
  return {
    scenario: "agent-launcher",
    checkpoint: "configuration-observed",
    messageId: stableId("claude"),
    stopReason: "end_turn",
    content: [{ type: "text", text: "Agent launcher configuration observed." }],
  };
}

export function codexTransition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
  if (!deepText(request.input).includes(MARKER)) {
    throw new OpenAiProtocolError("$.input", "does not select the scenario", "agent-launcher");
  }
  if (request.model !== CODEX_MODEL) {
    throw new OpenAiProtocolError("$.model", "does not contain the launcher-configured model", "agent-launcher");
  }
  return {
    scenario: "agent-launcher",
    checkpoint: "configuration-observed",
    output: finalOutput("Agent launcher configuration observed."),
  };
}

function finalOutput(text: string): OpenAiResponseOutput {
  return {
    type: "message",
    id: stableId("codex"),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
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

function stableId(provider: string): string {
  return `msg_e2e_${createHash("sha256").update(`agent-launcher:${provider}`).digest("hex").slice(0, 20)}`;
}
