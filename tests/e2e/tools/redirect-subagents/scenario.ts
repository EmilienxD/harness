import { createHash } from "node:crypto";

import {
  E2eProtocolError,
  isRecord,
  type AnthropicMessagesRequest,
  type AnthropicScenarioResponse,
} from "../../core/anthropic-protocol.js";

export const PARENT_MARKER = "[E2E:redirect-subagents:parent]";
export const CHILD_MARKER = "[E2E:redirect-subagents:child]";
export const CHILD_REPORT = "HARNESS_REDIRECT_CHILD_REPORT_7C21";
export const PARENT_COMPLETE = "HARNESS_REDIRECT_PARENT_COMPLETE_7C21";
export const scenarioCatalogHash = createHash("sha256").update("redirect-subagents:v1").digest("hex");

const AGENT_TOOL_ID = "toolu_e2e_redirect_subagents_agent";

export async function transition(request: AnthropicMessagesRequest): Promise<AnthropicScenarioResponse> {
  const text = deepText(request.messages);
  if (text.includes(PARENT_MARKER)) return parentTransition(request, text);
  if (text.includes(CHILD_MARKER)) return childTransition();
  throw new E2eProtocolError("$.messages", "does not select a parent or child journey", "redirect-subagents");
}

function parentTransition(request: AnthropicMessagesRequest, text: string): AnthropicScenarioResponse {
  const agentResult = resultFor(request, AGENT_TOOL_ID);
  if (agentResult === undefined) {
    const offered = request.tools.some((tool) => tool.name === "Agent");
    if (!offered) throw new E2eProtocolError("$.tools", "does not offer the native Agent tool", "redirect-subagents");
    return response("parent-agent-request", "tool_use", [{
      type: "tool_use",
      id: AGENT_TOOL_ID,
      name: "Agent",
      input: {
        description: "Return the deterministic redirect report",
        prompt: `${CHILD_MARKER} Return exactly ${CHILD_REPORT} and no other text.`,
        subagent_type: "Explore",
        run_in_background: true,
      },
    }]);
  }

  if (!deepText(agentResult).includes("started in the background")) {
    throw new E2eProtocolError("$.messages", "Agent result does not contain the redirect denial", "redirect-subagents");
  }
  // One copy is present in the original Agent prompt. The second copy can
  // only come from the redirected backend report injected by a delivery hook.
  if (occurrences(text, CHILD_REPORT) >= 2) {
    return response("parent-received-report", "end_turn", [{ type: "text", text: PARENT_COMPLETE }]);
  }
  return response("parent-waiting", "end_turn", [{ type: "text", text: "Waiting for the redirected report." }]);
}

async function childTransition(): Promise<AnthropicScenarioResponse> {
  // Keep the backend alive long enough for the parent to reach Stop, proving
  // that the shipped wait hook—not a lucky early completion—delivers it.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 4_000));
  return response("child-complete", "end_turn", [{ type: "text", text: CHILD_REPORT }]);
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

function response(
  checkpoint: string,
  stopReason: "tool_use" | "end_turn",
  content: readonly Record<string, unknown>[],
): AnthropicScenarioResponse {
  return {
    scenario: "redirect-subagents",
    checkpoint,
    messageId: `msg_e2e_${createHash("sha256").update(`redirect-subagents:${checkpoint}`).digest("hex").slice(0, 20)}`,
    stopReason,
    content,
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

function occurrences(value: string, marker: string): number {
  return value.split(marker).length - 1;
}
