import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { contains } from "./config.js";
import {
  E2eProtocolError,
  isRecord,
  parseAnthropicMessagesRequest,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicMessagesRequest,
  type AnthropicScenarioResponse,
} from "../../../../tests/e2e/core/anthropic-protocol.js";

export { isRecord } from "../../../../tests/e2e/core/anthropic-protocol.js";

export const SCENARIO_MARKER = "[E2E:single-file-success]";
export const AUTO_RUN_AFK_MARKER = "[E2E:auto-run-afk]";
export const AUTO_RUN_PERMANENT_NOTE = "E2E permanent auto-run guidance.";
export const AUTO_RUN_NESTED_CONTEXT = "E2E recursively resolved nested issue context.";
export const AUTO_RUN_EXPLORE_REPORT = "Explore verified deterministic.txt contains the canonical before fixture for this auto-run issue.";
export const AUTO_RUN_HITL_MARKER = "[E2E:auto-run-hitl]";
export const AUTO_RUN_HITL_REVIEW_MARKER = "[E2E:auto-run-hitl-review]";
export const HITL_ACCEPT_PROMPT = "Please commit all accepted changes now. [E2E:accept-hitl]";
export const AUTO_RUN_FOLLOWUP_MARKER = "[E2E:auto-run-followup]";
export const BEFORE_CONTENT = "harness e2e fixture: before\n";
export const AFTER_CONTENT = "harness e2e fixture: after\n";
/** No completion markup: a worker signals completion by committing. */
export const FINAL_RESPONSE = "Fixture updated and verified.";
export const WORKER_COMMIT_COMMAND = 'git add -A; git commit -m "Update deterministic fixture"';
export const REVIEW_APPROVAL_COMMIT_COMMAND = 'git commit --allow-empty -m "Approve deterministic fixture"';

export type ScenarioId = "single-file-success" | "auto-run-afk" | "auto-run-hitl" | "auto-run-hitl-review" | "auto-run-followup";

export const SCENARIO_MANIFEST = {
  schemaVersion: 1,
  id: "single-file-success",
  selector: { initialPromptContains: SCENARIO_MARKER },
  variables: { REPO_ROOT: { source: "runner", kind: "absolute_path" } },
  checkpoints: [
    { id: "read-target", when: { kind: "initial_request" }, respond: { kind: "tool_use", tool: "Read", toolUseId: "toolu_e2e_read_target", input: { file_path: "${REPO_ROOT}\\deterministic.txt" } } },
    { id: "edit-target", when: { kind: "tool_result", toolUseId: "toolu_e2e_read_target", contentContains: "harness e2e fixture: before" }, respond: { kind: "tool_use", tool: "Edit", toolUseId: "toolu_e2e_edit_target", input: { file_path: "${REPO_ROOT}\\deterministic.txt", old_string: "harness e2e fixture: before", new_string: "harness e2e fixture: after", replace_all: false } } },
    { id: "complete", when: { kind: "tool_result", toolUseId: "toolu_e2e_edit_target", isError: false }, respond: { kind: "text", stopReason: "end_turn", text: FINAL_RESPONSE } },
  ],
} as const;

export type ContentBlock = AnthropicContentBlock;
export type Message = AnthropicMessage;
export type MessagesRequest = AnthropicMessagesRequest;
export type ScenarioResponse = AnthropicScenarioResponse & { readonly scenario: ScenarioId };

export class ScenarioMismatch extends E2eProtocolError {
  constructor(readonly field: string, detail: string, scenario: ScenarioId = "single-file-success") {
    super(field, detail, scenario);
    this.name = "ScenarioMismatch";
  }
}

const READ_ID = "toolu_e2e_read_target";
const EDIT_ID = "toolu_e2e_edit_target";

export function parseMessagesRequest(value: unknown, inference: boolean): MessagesRequest {
  return parseAnthropicMessagesRequest(value, inference);
}

export function transition(request: MessagesRequest, repoRoot: string): ScenarioResponse {
  const scenario = selectScenario(request.messages);
  if (scenario === "auto-run-afk") return autoRunAfkTransition(request, repoRoot);
  if (scenario === "auto-run-hitl-review" && (messageText(request.messages).includes("in the exact range") || messageText(request.messages).includes("Aboard pinned "))) {
    return autoRunHitlReviewTransition(request, repoRoot, scenario);
  }
  if (scenario === "auto-run-hitl" || scenario === "auto-run-hitl-review") return autoRunSequentialTransition(request, repoRoot, {
    scenario, checkpoint: "auto-hitl", readId: "toolu_e2e_auto_hitl_read", editId: "toolu_e2e_auto_hitl_edit",
    before: BEFORE_CONTENT.trimEnd(), after: AFTER_CONTENT.trimEnd(),
  });
  if (scenario === "auto-run-followup") return autoRunSequentialTransition(request, repoRoot, {
    scenario, checkpoint: "auto-followup", readId: "toolu_e2e_auto_followup_read", editId: "toolu_e2e_auto_followup_edit",
    before: AFTER_CONTENT.trimEnd(), after: "harness e2e fixture: complete",
  });
  return singleFileTransition(request, repoRoot);
}

function autoRunSequentialTransition(request: MessagesRequest, repoRoot: string, input: {
  readonly scenario: "auto-run-hitl" | "auto-run-hitl-review" | "auto-run-followup";
  readonly checkpoint: "auto-hitl" | "auto-followup";
  readonly readId: string;
  readonly editId: string;
  readonly before: string;
  readonly after: string;
}): ScenarioResponse {
  const commitId = `${input.editId}_commit`;
  const results = scenarioSequenceResults(request.messages, [
    { id: input.readId, name: "Read" },
    { id: input.editId, name: "Edit" },
    { id: commitId, name: "Bash" },
  ], input.scenario);
  const read = results.get(input.readId);
  if (!read) {
    requireScenarioTool(request, "Read", input.scenario);
    return {
      scenario: input.scenario,
      checkpoint: `${input.checkpoint}-read`,
      messageId: scenarioStableId(input.scenario, `${input.checkpoint}-read`),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: input.readId, name: "Read", input: { file_path: fixturePath(repoRoot) } }],
    };
  }
  if (read.is_error === true || !contentContains(read.content, input.before)) throw new ScenarioMismatch("$.messages", "Read result omitted expected sequential fixture state", input.scenario);
  const edit = results.get(input.editId);
  if (!edit) {
    requireScenarioTool(request, "Edit", input.scenario);
    return {
      scenario: input.scenario,
      checkpoint: `${input.checkpoint}-edit`,
      messageId: scenarioStableId(input.scenario, `${input.checkpoint}-edit`),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: input.editId, name: "Edit", input: { file_path: fixturePath(repoRoot), old_string: input.before, new_string: input.after, replace_all: false } }],
    };
  }
  if (edit.is_error === true) throw new ScenarioMismatch("$.messages", "Edit tool_result reported an error", input.scenario);
  const commit = results.get(commitId);
  const userText = messageText(request.messages.filter((message) => message.role === "user"));
  if (input.scenario === "auto-run-hitl" && !userText.includes(HITL_ACCEPT_PROMPT)) {
    if (commit) throw new ScenarioMismatch("$.messages", "HITL committed before user acceptance", input.scenario);
    return { scenario: input.scenario, checkpoint: "auto-hitl-handoff", messageId: scenarioStableId(input.scenario, "auto-hitl-handoff"), stopReason: "end_turn", content: [{ type: "text", text: "Implementation is ready for your review; changes are uncommitted." }] };
  }
  if (!commit) {
    requireScenarioTool(request, "Bash", input.scenario);
    return {
      scenario: input.scenario,
      checkpoint: `${input.checkpoint}-commit`,
      messageId: scenarioStableId(input.scenario, `${input.checkpoint}-commit`),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: commitId, name: "Bash", input: { command: WORKER_COMMIT_COMMAND } }],
    };
  }
  if (commit.is_error === true) throw new ScenarioMismatch("$.messages", "the worker's commit reported an error", input.scenario);
  return {
    scenario: input.scenario,
    checkpoint: `${input.checkpoint}-complete`,
    messageId: scenarioStableId(input.scenario, `${input.checkpoint}-complete`),
    stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_RESPONSE }],
  };
}

function autoRunHitlReviewTransition(request: MessagesRequest, repoRoot: string, scenario: "auto-run-hitl-review"): ScenarioResponse {
  const readId = "toolu_e2e_auto_hitl_review_read";
  const commitId = "toolu_e2e_auto_hitl_accept_commit";
  const results = scenarioSequenceResults(request.messages, [
    { id: readId, name: "Read" },
    { id: commitId, name: "Bash" },
  ], scenario);
  const read = results.get(readId);
  if (!read) {
    requireScenarioTool(request, "Read", scenario);
    return {
      scenario,
      checkpoint: "auto-hitl-review-read",
      messageId: scenarioStableId(scenario, "auto-hitl-review-read"),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: readId, name: "Read", input: { file_path: fixturePath(repoRoot) } }],
    };
  }
  if (read.is_error === true || !contentContains(read.content, AFTER_CONTENT.trimEnd())) {
    throw new ScenarioMismatch("$.messages", "HITL review did not observe the reset implementation", scenario);
  }
  const acceptanceRequested = messageText(request.messages.filter((message) => message.role === "user")).includes(HITL_ACCEPT_PROMPT);
  const commit = results.get(commitId);
  if (!acceptanceRequested) {
    if (commit) throw new ScenarioMismatch("$.messages", "HITL review committed during its automated turn", scenario);
    return {
      scenario,
      checkpoint: "auto-hitl-review-complete",
      messageId: scenarioStableId(scenario, "auto-hitl-review-complete"),
      stopReason: "end_turn",
      content: [{ type: "text", text: "Review complete; no fixes required." }],
    };
  }
  if (!commit) {
    requireScenarioTool(request, "Bash", scenario);
    return {
      scenario,
      checkpoint: "auto-hitl-accept-commit",
      messageId: scenarioStableId(scenario, "auto-hitl-accept-commit"),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: commitId, name: "Bash", input: { command: WORKER_COMMIT_COMMAND } }],
    };
  }
  if (commit.is_error === true) throw new ScenarioMismatch("$.messages", "the HITL acceptance commit reported an error", scenario);
  return {
    scenario,
    checkpoint: "auto-hitl-accept-complete",
    messageId: scenarioStableId(scenario, "auto-hitl-accept-complete"),
    stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_RESPONSE }],
  };
}

function autoRunAfkTransition(request: MessagesRequest, repoRoot: string): ScenarioResponse {
  const scenario = "auto-run-afk" as const;
  const history = messageText(request.messages);
  if (history.includes("<work-to-explore>")) return autoRunExploreTransition(request, repoRoot);
  if (history.includes("Review pull request")) {
    const commitId = "toolu_e2e_auto_review_commit";
    const commit = scenarioSequenceResults(request.messages, [{ id: commitId, name: "Bash" }], scenario).get(commitId);
    if (!commit) {
      requireScenarioTool(request, "Bash", scenario);
      return {
        scenario,
        checkpoint: "auto-review-commit",
        messageId: scenarioStableId(scenario, "auto-review-commit"),
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: commitId, name: "Bash", input: { command: REVIEW_APPROVAL_COMMIT_COMMAND } }],
      };
    }
    if (commit.is_error === true) throw new ScenarioMismatch("$.messages", "the review's approval commit reported an error", scenario);
    return {
      scenario,
      checkpoint: "auto-review-complete",
      messageId: scenarioStableId(scenario, "auto-review-complete"),
      stopReason: "end_turn",
      content: [{ type: "text", text: "Review complete; no fixes required." }],
    };
  }
  const readId = "toolu_e2e_auto_afk_read";
  const editId = "toolu_e2e_auto_afk_edit";
  const commitId = "toolu_e2e_auto_afk_commit";
  const results = scenarioSequenceResults(request.messages, [
    { id: readId, name: "Read" },
    { id: editId, name: "Edit" },
    { id: commitId, name: "Bash" },
  ], scenario);
  const readResult = results.get(readId);
  const editResult = results.get(editId);
  if (!readResult) {
    requireScenarioTool(request, "Read", scenario);
    return {
      scenario,
      checkpoint: "auto-afk-read",
      messageId: scenarioStableId(scenario, "auto-afk-read"),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: readId, name: "Read", input: { file_path: fixturePath(repoRoot) } }],
    };
  }
  if (readResult.is_error === true || !contentContains(readResult.content, BEFORE_CONTENT.trimEnd())) {
    throw new ScenarioMismatch("$.messages", "Read tool_result did not contain the expected fixture marker", scenario);
  }
  if (!editResult) {
    requireScenarioTool(request, "Edit", scenario);
    return {
      scenario,
      checkpoint: "auto-afk-edit",
      messageId: scenarioStableId(scenario, "auto-afk-edit"),
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: editId,
        name: "Edit",
        input: {
          file_path: fixturePath(repoRoot),
          old_string: BEFORE_CONTENT.trimEnd(),
          new_string: AFTER_CONTENT.trimEnd(),
          replace_all: false,
        },
      }],
    };
  }
  if (editResult.is_error === true) throw new ScenarioMismatch("$.messages", "Edit tool_result reported an error", scenario);
  const commitResult = results.get(commitId);
  if (!commitResult) {
    requireScenarioTool(request, "Bash", scenario);
    return {
      scenario,
      checkpoint: "auto-afk-commit",
      messageId: scenarioStableId(scenario, "auto-afk-commit"),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: commitId, name: "Bash", input: { command: WORKER_COMMIT_COMMAND } }],
    };
  }
  if (commitResult.is_error === true) throw new ScenarioMismatch("$.messages", "the worker's commit reported an error", scenario);
  return {
    scenario,
    checkpoint: "auto-afk-complete",
    messageId: scenarioStableId(scenario, "auto-afk-complete"),
    stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_RESPONSE }],
  };
}

function autoRunExploreTransition(request: MessagesRequest, repoRoot: string): ScenarioResponse {
  const scenario = "auto-run-afk" as const;
  const toolName = "Read";
  const toolUseId = "toolu_e2e_auto_explore_read";
  const result = scenarioToolResult(request.messages, toolUseId, toolName, scenario);
  if (!result) {
    requireScenarioTool(request, toolName, scenario);
    return {
      scenario,
      checkpoint: "auto-explore-read",
      messageId: scenarioStableId(scenario, "auto-explore-read"),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: toolUseId, name: toolName, input: { file_path: fixturePath(repoRoot) } }],
    };
  }
  if (result.is_error === true || !contentContains(result.content, BEFORE_CONTENT.trimEnd())) {
    throw new ScenarioMismatch("$.messages", "Explore Read did not contain the expected fixture marker", scenario);
  }
  return {
    scenario,
    checkpoint: "auto-explore-complete",
    messageId: scenarioStableId(scenario, "auto-explore-complete"),
    stopReason: "end_turn",
    content: [{ type: "text", text: AUTO_RUN_EXPLORE_REPORT }],
  };
}

function singleFileTransition(request: MessagesRequest, repoRoot: string): ScenarioResponse {
  const offeredTools = new Set(request.tools.map((tool) => tool.name).filter((name): name is string => typeof name === "string"));
  const blocks = flattenBlocks(request.messages);

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
  if (!contentContains(readResult.content, "harness e2e fixture: before")) {
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
    scenario: "single-file-success",
    checkpoint: "complete",
    messageId: stableId("msg", "complete"),
    stopReason: "end_turn",
    content: [{ type: "text", text: FINAL_RESPONSE }],
  };
}

function toolResponse(checkpoint: "read-target" | "edit-target", id: string, name: string, input: Record<string, unknown>): ScenarioResponse {
  return {
    scenario: "single-file-success",
    checkpoint,
    messageId: stableId("msg", checkpoint),
    stopReason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
  };
}


function requireScenarioTool(request: MessagesRequest, name: string, scenario: ScenarioId): void {
  const offered = request.tools.some((tool) => tool.name === name);
  if (!offered) throw new ScenarioMismatch("$.tools", `required tool ${name} is unavailable`, scenario);
}

function scenarioToolResult(messages: readonly Message[], expectedId: string, expectedName: string, scenario: ScenarioId): ContentBlock | undefined {
  let useMessage = -1;
  let resultMessage = -1;
  let result: ContentBlock | undefined;
  let useCount = 0;
  let resultCount = 0;
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content.filter(isRecord) as ContentBlock[]) {
      if (block.type === "tool_use") {
        if (block.id !== expectedId) throw new ScenarioMismatch("$.messages", `unknown tool_use id hash ${hashValue(block.id)}`, scenario);
        if (block.name !== expectedName) throw new ScenarioMismatch("$.messages", "tool_use has unexpected tool name", scenario);
        useCount += 1;
        useMessage = messageIndex;
      }
      if (block.type === "tool_result") {
        if (block.tool_use_id !== expectedId) throw new ScenarioMismatch("$.messages", `unknown tool_result id hash ${hashValue(block.tool_use_id)}`, scenario);
        resultCount += 1;
        resultMessage = messageIndex;
        result = block;
      }
    }
  });
  if (useCount > 1) throw new ScenarioMismatch("$.messages", `duplicate tool_use id hash ${hashValue(expectedId)}`, scenario);
  if (resultCount > 1) throw new ScenarioMismatch("$.messages", `duplicate tool_result id hash ${hashValue(expectedId)}`, scenario);
  if (result && (useCount !== 1 || resultMessage !== useMessage + 1 || messages[useMessage]?.role !== "assistant" || messages[resultMessage]?.role !== "user")) {
    throw new ScenarioMismatch("$.messages", "tool_result must immediately follow its assistant tool_use turn", scenario);
  }
  return result;
}

function scenarioSequenceResults(
  messages: readonly Message[],
  expected: readonly { readonly id: string; readonly name: string }[],
  scenario: ScenarioId,
): ReadonlyMap<string, ContentBlock> {
  const definitions = new Map(expected.map((entry) => [entry.id, entry.name]));
  const uses = new Map<string, number>();
  const results = new Map<string, ContentBlock>();
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content.filter(isRecord) as ContentBlock[]) {
      if (block.type === "tool_use") {
        const name = typeof block.id === "string" ? definitions.get(block.id) : undefined;
        if (name === undefined) throw new ScenarioMismatch("$.messages", `unknown tool_use id hash ${hashValue(block.id)}`, scenario);
        if (block.name !== name) throw new ScenarioMismatch("$.messages", "tool_use has unexpected tool name", scenario);
        if (uses.has(block.id as string)) throw new ScenarioMismatch("$.messages", `duplicate tool_use id hash ${hashValue(block.id)}`, scenario);
        uses.set(block.id as string, messageIndex);
      }
      if (block.type === "tool_result") {
        const id = block.tool_use_id;
        if (typeof id !== "string" || !definitions.has(id)) throw new ScenarioMismatch("$.messages", `unknown tool_result id hash ${hashValue(id)}`, scenario);
        if (results.has(id)) throw new ScenarioMismatch("$.messages", `duplicate tool_result id hash ${hashValue(id)}`, scenario);
        const useMessage = uses.get(id);
        if (useMessage === undefined || messageIndex !== useMessage + 1 || messages[useMessage]?.role !== "assistant" || message.role !== "user") {
          throw new ScenarioMismatch("$.messages", "tool_result must immediately follow its assistant tool_use turn", scenario);
        }
        results.set(id, block);
      }
    }
  });
  for (let index = 1; index < expected.length; index += 1) {
    const priorResult = results.get(expected[index - 1]!.id);
    const currentUse = uses.get(expected[index]!.id);
    if (currentUse !== undefined && priorResult === undefined) {
      throw new ScenarioMismatch("$.messages", `${expected[index]!.name} appeared before the prior tool result`, scenario);
    }
  }
  return results;
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

function scenarioStableId(scenario: ScenarioId, checkpoint: string): string {
  return `msg_e2e_${createHash("sha256").update(`${scenario}:${checkpoint}`).digest("hex").slice(0, 16)}`;
}

function flattenBlocks(messages: readonly Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) blocks.push(...message.content.filter(isRecord) as ContentBlock[]);
  }
  return blocks;
}

function selectScenario(messages: readonly Message[]): ScenarioId {
  const text = messageText(messages);
  if (/Review issue #\d+; Accept deterministic (?:per-issue|single-branch) change after review in the exact range/u.test(text)) return "auto-run-hitl-review";
  if (text.includes("Review pull request") && text.includes(AUTO_RUN_PERMANENT_NOTE)) return "auto-run-afk";
  const markers = [
    ["single-file-success", [SCENARIO_MARKER]],
    ["auto-run-afk", [AUTO_RUN_AFK_MARKER]],
    ["auto-run-hitl", [AUTO_RUN_HITL_MARKER]],
    ["auto-run-hitl-review", [AUTO_RUN_HITL_REVIEW_MARKER]],
    ["auto-run-followup", [AUTO_RUN_FOLLOWUP_MARKER]],
  ] as const;
  const counts = new Map<ScenarioId, number>(markers.map(([id]) => [id, 0]));
  for (const block of flattenBlocks(messages)) {
    if (block.type !== "text") continue;
    for (const [id, selectors] of markers) {
      if (typeof block.content === "string") counts.set(id, counts.get(id)! + selectors.reduce((sum, marker) => sum + occurrences(block.content as string, marker), 0));
      if (typeof block.text === "string") counts.set(id, counts.get(id)! + selectors.reduce((sum, marker) => sum + occurrences(block.text as string, marker), 0));
    }
  }
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    for (const [id, selectors] of markers) counts.set(id, counts.get(id)! + selectors.reduce((sum, marker) => sum + occurrences(message.content as string, marker), 0));
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total !== 1) throw new ScenarioMismatch("$.messages", `expected exactly one scenario marker; found ${total}`);
  return markers.find(([id]) => counts.get(id) === 1)![0];
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function messageText(messages: readonly Message[]): string {
  const values: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") values.push(message.content);
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content.filter(isRecord)) {
      if (typeof block.text === "string") values.push(block.text);
      if (block.type === "tool_result" && typeof block.content === "string") values.push(block.content);
    }
  }
  return values.join("\n");
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
