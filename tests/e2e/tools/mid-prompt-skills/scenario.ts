import { createHash } from "node:crypto";

import { E2eProtocolError, isRecord, parseAnthropicMessagesRequest, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";

export const MID_MARKER = "[E2E:mid-prompt-skills:mid]";
export const LEAD_SKILL = "e2e-lead";
export const MID_SKILL = "e2e-mid";
export const LEAD_BODY = "LEAD-SKILL-LOADED args=$ARGUMENTS";
export const MID_BODY = "MID-SKILL-LOADED first=$0 all=$ARGUMENTS";
export const MID_PROMPT = `${MID_MARKER}\n- Q1: B. Keep it small. /${MID_SKILL} alpha "beta gamma"\n- Q2: A.`;
export const LEADING_PROMPT = `/${LEAD_SKILL} first. Then /${MID_SKILL} second`;
export const FINAL_MESSAGE = "Skill instructions received.";

export const scenarioCatalogHash = createHash("sha256").update("mid-prompt-skills:v1").digest("hex");
export const parseRequest = parseAnthropicMessagesRequest;

/** Rendered bodies only exist after substitution, so the raw prompt text can never satisfy these checks. */
export function transition(request: AnthropicMessagesRequest): AnthropicScenarioResponse {
  const text = textParts(request.messages).join("\n");
  if (text.includes(MID_MARKER)) {
    requireOnce(text, 'MID-SKILL-LOADED first=alpha all=alpha "beta gamma"', "mid-prompt skill was not loaded with its line's arguments");
    return complete("mid-prompt-skill");
  }
  if (text.includes("LEAD-SKILL-LOADED")) {
    requireOnce(text, "LEAD-SKILL-LOADED", "leading skill was not loaded exactly once");
    requireOnce(text, `LEAD-SKILL-LOADED args=first. Then /${MID_SKILL} second`, "leading skill was not expanded by Claude Code");
    requireOnce(text, "MID-SKILL-LOADED", "skill after the leading one was not loaded exactly once");
    requireOnce(text, "MID-SKILL-LOADED first=second all=second", "skill after the leading one lost its arguments");
    return complete("leading-and-later-skill");
  }
  throw new E2eProtocolError("$.messages", "does not select a mid-prompt-skills scenario", "mid-prompt-skills");
}

function requireOnce(text: string, needle: string, failure: string): void {
  if (text.split(needle).length !== 2) throw new E2eProtocolError("$.messages", failure, "mid-prompt-skills");
}

function complete(checkpoint: string): AnthropicScenarioResponse {
  return {
    scenario: "mid-prompt-skills", checkpoint, messageId: stableId(checkpoint), stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_MESSAGE }],
  };
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textParts);
  if (isRecord(value)) return Object.values(value).flatMap(textParts);
  return [];
}

function stableId(checkpoint: string): string {
  return `msg_e2e_${createHash("sha256").update(`mid-prompt-skills:${checkpoint}`).digest("hex").slice(0, 20)}`;
}
