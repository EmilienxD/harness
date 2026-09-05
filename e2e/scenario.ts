import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { contains } from "./config.js";

export const SCENARIO_MARKER = "[E2E:single-file-success]";
export const BEFORE_CONTENT = "aboard e2e fixture: before\n";
export const AFTER_CONTENT = "aboard e2e fixture: after\n";
export const FINAL_RESPONSE = "Fixture updated and verified.\n\n<commit>Update deterministic fixture</commit>";

export const SCENARIO_MANIFEST = {
  schemaVersion: 1,
  id: "single-file-success",
  selector: { initialPromptContains: SCENARIO_MARKER },
  variables: { REPO_ROOT: { source: "runner", kind: "absolute_path" } },
  checkpoints: [
    { id: "read-target", when: { kind: "initial_request" }, respond: { kind: "tool_use", tool: "Read", toolUseId: "toolu_e2e_read_target", input: { file_path: "${REPO_ROOT}\\deterministic.txt" } } },
    { id: "edit-target", when: { kind: "tool_result", toolUseId: "toolu_e2e_read_target", contentContains: "aboard e2e fixture: before" }, respond: { kind: "tool_use", tool: "Edit", toolUseId: "toolu_e2e_edit_target", input: { file_path: "${REPO_ROOT}\\deterministic.txt", old_string: "aboard e2e fixture: before", new_string: "aboard e2e fixture: after", replace_all: false } } },
    { id: "complete", when: { kind: "tool_result", toolUseId: "toolu_e2e_edit_target", isError: false }, respond: { kind: "text", stopReason: "end_turn", text: FINAL_RESPONSE } },
  ],
} as const;

export interface ContentBlock {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly is_error?: unknown;
  readonly [key: string]: unknown;
}

export interface Message {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

export interface MessagesRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly Message[];
  readonly stream: boolean;
  readonly tools: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export interface ScenarioResponse {
  readonly checkpoint: "read-target" | "edit-target" | "complete";
  readonly messageId: string;
  readonly stopReason: "tool_use" | "end_turn";
  readonly content: readonly Record<string, unknown>[];
}

export class ScenarioMismatch extends Error {
  constructor(readonly field: string, detail: string) {
    super(`scenario single-file-success at ${field}: ${detail}`);
    this.name = "ScenarioMismatch";
  }
}

const READ_ID = "toolu_e2e_read_target";
const EDIT_ID = "toolu_e2e_edit_target";

export function parseMessagesRequest(value: unknown, inference: boolean): MessagesRequest {
  if (!isRecord(value)) throw new ScenarioMismatch("$", "request body must be an object");
  if (typeof value.model !== "string" || value.model.length === 0) throw new ScenarioMismatch("$.model", "must be a nonempty string");
  if (!Array.isArray(value.messages)) throw new ScenarioMismatch("$.messages", "must be an array");
  if (inference && (!Number.isInteger(value.max_tokens) || (value.max_tokens as number) <= 0)) {
    throw new ScenarioMismatch("$.max_tokens", "must be a positive integer");
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") throw new ScenarioMismatch("$.stream", "must be boolean when present");
  if (inference && !Array.isArray(value.tools)) throw new ScenarioMismatch("$.tools", "must be an array");
  validateMessageShape(value.messages);
  return {
    ...value,
    model: value.model,
    max_tokens: typeof value.max_tokens === "number" ? value.max_tokens : 1,
    messages: value.messages as Message[],
    stream: value.stream === true,
    tools: Array.isArray(value.tools) ? value.tools.filter(isRecord) : [],
  };
}

function validateMessageShape(messages: readonly unknown[]): void {
  if (messages.length === 0) throw new ScenarioMismatch("$.messages", "must contain at least one message");
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) throw new ScenarioMismatch(`$.messages[${messageIndex}]`, "must be an object");
    if (typeof message.role !== "string" || message.role.length === 0) throw new ScenarioMismatch(`$.messages[${messageIndex}].role`, "must be a nonempty string");
    if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new ScenarioMismatch(`$.messages[${messageIndex}].content`, "must be a string or block array");
    if (!Array.isArray(message.content)) return;
    let sawText = false;
    message.content.forEach((block, blockIndex) => {
      if (!isRecord(block) || typeof block.type !== "string") throw new ScenarioMismatch(`$.messages[${messageIndex}].content[${blockIndex}]`, "must be a typed block object");
      if (message.role === "user" && block.type === "text") sawText = true;
      if (message.role === "user" && block.type === "tool_result" && sawText) {
        throw new ScenarioMismatch(`$.messages[${messageIndex}].content[${blockIndex}]`, "tool_result blocks must precede text blocks");
      }
    });
  });
}

export function transition(request: MessagesRequest, repoRoot: string): ScenarioResponse {
  const offeredTools = new Set(request.tools.map((tool) => tool.name).filter((name): name is string => typeof name === "string"));
  const blocks = flattenBlocks(request.messages);
  const markerCount = countMarker(request.messages);
  if (markerCount !== 1) throw new ScenarioMismatch("$.messages", `expected exactly one scenario marker; found ${markerCount}`);

  const uses = blocks.filter((block) => block.type === "tool_use");
  const results = blocks.filter((block) => block.type === "tool_result");
  validateKnownUses(uses);
  validateKnownResults(results);
  validateHistoryOrder(request.messages);

  const readResult = resultFor(results, READ_ID);
  const editResult = resultFor(results, EDIT_ID);
  if (!readResult) {
    if (editResult || uses.some((block) => block.id === EDIT_ID)) throw new ScenarioMismatch("$.messages", "Edit appeared before the Read result");
    requireTool(offeredTools, "Read");
    const filePath = fixturePath(repoRoot);
    return toolResponse("read-target", READ_ID, "Read", { file_path: filePath });
  }
  if (readResult.is_error === true) throw new ScenarioMismatch("$.messages", "Read tool_result reported an error");
  if (!contentContains(readResult.content, "aboard e2e fixture: before")) {
    throw new ScenarioMismatch("$.messages", "Read tool_result did not contain the expected fixture marker");
  }
  if (!editResult) {
    requireTool(offeredTools, "Edit");
    return toolResponse("edit-target", EDIT_ID, "Edit", {
      file_path: fixturePath(repoRoot), old_string: BEFORE_CONTENT.trimEnd(), new_string: AFTER_CONTENT.trimEnd(), replace_all: false,
    });
  }
  if (editResult.is_error === true) throw new ScenarioMismatch("$.messages", "Edit tool_result reported an error");
  return {
    checkpoint: "complete",
    messageId: stableId("msg", "complete"),
    stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_RESPONSE }],
  };
}

function toolResponse(checkpoint: "read-target" | "edit-target", id: string, name: string, input: Record<string, unknown>): ScenarioResponse {
  return {
    checkpoint,
    messageId: stableId("msg", checkpoint),
    stopReason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
  };
}

function fixturePath(repoRoot: string): string {
  const root = resolve(repoRoot);
  const path = resolve(root, "deterministic.txt");
  if (!contains(root, path)) throw new ScenarioMismatch("manifest.variables.REPO_ROOT", "fixture path escaped repository root");
  return path;
}

function stableId(prefix: string, checkpoint: string): string {
  return `${prefix}_e2e_${createHash("sha256").update(`single-file-success:${checkpoint}`).digest("hex").slice(0, 16)}`;
}

function flattenBlocks(messages: readonly Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) blocks.push(...message.content.filter(isRecord) as ContentBlock[]);
  }
  return blocks;
}

function countMarker(messages: readonly Message[]): number {
  let count = 0;
  for (const block of flattenBlocks(messages)) {
    if (block.type === "text" && typeof block.content === "string") count += occurrences(block.content, SCENARIO_MARKER);
    if (block.type === "text" && typeof block.text === "string") count += occurrences(block.text, SCENARIO_MARKER);
  }
  for (const message of messages) if (typeof message.content === "string") count += occurrences(message.content, SCENARIO_MARKER);
  return count;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function validateKnownUses(uses: readonly ContentBlock[]): void {
  const seen = new Set<string>();
  for (const block of uses) {
    if (block.id !== READ_ID && block.id !== EDIT_ID) throw new ScenarioMismatch("$.messages", `unknown tool_use id hash ${hashValue(block.id)}`);
    const expected = block.id === READ_ID ? "Read" : "Edit";
    if (block.name !== expected) throw new ScenarioMismatch("$.messages", `tool_use ${hashValue(block.id)} has unexpected tool name`);
    if (seen.has(block.id)) throw new ScenarioMismatch("$.messages", `duplicate tool_use id hash ${hashValue(block.id)}`);
    seen.add(block.id);
  }
}

function validateHistoryOrder(messages: readonly Message[]): void {
  let readUse = -1;
  let readResult = -1;
  let editUse = -1;
  let editResult = -1;
  messages.forEach((message, messageIndex) => {
    const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) as ContentBlock[] : [];
    for (const block of blocks) {
      if (block.type === "tool_use" && block.id === READ_ID) readUse = messageIndex;
      if (block.type === "tool_result" && block.tool_use_id === READ_ID) readResult = messageIndex;
      if (block.type === "tool_use" && block.id === EDIT_ID) editUse = messageIndex;
      if (block.type === "tool_result" && block.tool_use_id === EDIT_ID) editResult = messageIndex;
    }
  });
  if (readResult >= 0 && (readUse < 0 || readResult !== readUse + 1 || messages[readUse]?.role !== "assistant" || messages[readResult]?.role !== "user")) {
    throw new ScenarioMismatch("$.messages", "Read tool_result must immediately follow its assistant tool_use turn");
  }
  if (editUse >= 0 && (readResult < 0 || editUse <= readResult)) throw new ScenarioMismatch("$.messages", "Edit tool_use must follow the Read tool_result");
  if (editResult >= 0 && (editUse < 0 || editResult !== editUse + 1 || messages[editUse]?.role !== "assistant" || messages[editResult]?.role !== "user")) {
    throw new ScenarioMismatch("$.messages", "Edit tool_result must immediately follow its assistant tool_use turn");
  }
}

function validateKnownResults(results: readonly ContentBlock[]): void {
  const seen = new Set<string>();
  for (const block of results) {
    if (block.tool_use_id !== READ_ID && block.tool_use_id !== EDIT_ID) {
      throw new ScenarioMismatch("$.messages", `unknown tool_result id hash ${hashValue(block.tool_use_id)}`);
    }
    if (seen.has(block.tool_use_id)) throw new ScenarioMismatch("$.messages", `duplicate tool_result id hash ${hashValue(block.tool_use_id)}`);
    seen.add(block.tool_use_id);
  }
}

function resultFor(results: readonly ContentBlock[], id: string): ContentBlock | undefined {
  return results.find((block) => block.tool_use_id === id);
}

function requireTool(tools: ReadonlySet<string>, name: string): void {
  if (!tools.has(name)) throw new ScenarioMismatch("$.tools", `required tool ${name} is unavailable`);
}

function contentContains(content: unknown, marker: string): boolean {
  if (typeof content === "string") return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((part) => isRecord(part) && typeof part.text === "string" && part.text.includes(marker));
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
