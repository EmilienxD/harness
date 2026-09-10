export interface AnthropicContentBlock {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly is_error?: unknown;
  readonly [key: string]: unknown;
}

export interface AnthropicMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

export interface AnthropicMessagesRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly AnthropicMessage[];
  readonly stream: boolean;
  readonly tools: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export interface AnthropicScenarioResponse {
  readonly scenario: string;
  readonly checkpoint: string;
  readonly messageId: string;
  readonly stopReason: "tool_use" | "end_turn";
  readonly content: readonly Record<string, unknown>[];
}

export class E2eProtocolError extends Error {
  constructor(readonly field: string, detail: string, scenario = "request") {
    super(`scenario ${scenario} at ${field}: ${detail}`);
    this.name = "E2eProtocolError";
  }
}

export function parseAnthropicMessagesRequest(value: unknown, inference: boolean): AnthropicMessagesRequest {
  if (!isRecord(value)) throw new E2eProtocolError("$", "request body must be an object");
  if (typeof value.model !== "string" || value.model.length === 0) throw new E2eProtocolError("$.model", "must be a nonempty string");
  if (!Array.isArray(value.messages)) throw new E2eProtocolError("$.messages", "must be an array");
  if (inference && (!Number.isInteger(value.max_tokens) || (value.max_tokens as number) <= 0)) {
    throw new E2eProtocolError("$.max_tokens", "must be a positive integer");
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") throw new E2eProtocolError("$.stream", "must be boolean when present");
  if (inference && !Array.isArray(value.tools)) throw new E2eProtocolError("$.tools", "must be an array");
  validateMessageShape(value.messages);
  return {
    ...value,
    model: value.model,
    max_tokens: typeof value.max_tokens === "number" ? value.max_tokens : 1,
    messages: value.messages,
    stream: value.stream === true,
    tools: Array.isArray(value.tools) ? value.tools.filter(isRecord) : [],
  };
}

function validateMessageShape(messages: readonly unknown[]): void {
  if (messages.length === 0) throw new E2eProtocolError("$.messages", "must contain at least one message");
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) throw new E2eProtocolError(`$.messages[${messageIndex}]`, "must be an object");
    if (typeof message.role !== "string" || message.role.length === 0) throw new E2eProtocolError(`$.messages[${messageIndex}].role`, "must be a nonempty string");
    if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new E2eProtocolError(`$.messages[${messageIndex}].content`, "must be a string or block array");
    if (!Array.isArray(message.content)) return;
    let sawText = false;
    message.content.forEach((block, blockIndex) => {
      if (!isRecord(block) || typeof block.type !== "string") throw new E2eProtocolError(`$.messages[${messageIndex}].content[${blockIndex}]`, "must be a typed block object");
      if (message.role === "user" && block.type === "text") sawText = true;
      if (message.role === "user" && block.type === "tool_result" && sawText) {
        throw new E2eProtocolError(`$.messages[${messageIndex}].content[${blockIndex}]`, "tool_result blocks must precede text blocks");
      }
    });
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
