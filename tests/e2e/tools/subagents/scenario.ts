import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { containsPath } from "../../core/path.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const PARENT_MARKER = "HARNESS_SUBAGENTS_PARENT_E2E_91D4";
export const CHILD_MARKER = "HARNESS_SUBAGENTS_CHILD_E2E_7B2A";
export const CHILD_REPLY = "HARNESS_SUBAGENTS_CHILD_COMPLETE_48CF: inspected the delegated task.";
export const NEXT_MARKER = "HARNESS_SUBAGENTS_NEXT_E2E_C241";
export const NEXT_REPLY = "HARNESS_SUBAGENTS_NEXT_COMPLETE_640C: continued the saved conversation.";
export const PARENT_REPLY = "HARNESS_SUBAGENTS_PARENT_COMPLETE_33A1: received the child reply.";
export const RECOVERY_MARKER = "HARNESS_SUBAGENTS_RECOVERY_E2E_762B";
export const RECOVERY_PARENT_REPLY = "HARNESS_SUBAGENTS_RECOVERY_COMPLETE_639A: received the resumed child reply.";
export type SkillSelection = "none" | "found" | "missing";
export const SKILL_RESOURCE = "[E2E:subagents:loaded-skill]";
export const SKILL_RECEIPT = "selected-skill.json";
export const CHILD_PROGRESS = "child checkpoint before interruption\n";
export const scenarioCatalogHash = createHash("sha256").update("subagents:v5:explicit-inbox-activation").digest("hex");

const CLAUDE_ENABLE_ID = "toolu_e2e_subagents_enable";
const CODEX_ENABLE_ID = "call_e2e_subagents_enable";

const CLAUDE_WRITE_ID = "toolu_e2e_subagents_request";
const CLAUDE_REPLY_ID = "toolu_e2e_subagents_reply";
const CODEX_WRITE_ID = "call_e2e_subagents_request";
const CODEX_REPLY_ID = "call_e2e_subagents_reply";
const CLAUDE_PROGRESS_ID = "toolu_e2e_subagents_progress";
const CODEX_PROGRESS_ID = "call_e2e_subagents_progress";
const CLAUDE_RESUME_ID = "toolu_e2e_subagents_resume";
const CODEX_RESUME_ID = "call_e2e_subagents_resume";

export function claudeTransition(request: AnthropicMessagesRequest, repoRoot: string, mode: "interactive" | "auto" = "interactive", recovery = false, alternateRoot = false, stopFallback = false, selection: SkillSelection = "none"): AnthropicScenarioResponse {
  const text = deepText(request.messages);
  if (recovery && text.includes(PARENT_MARKER) && text.includes(RECOVERY_MARKER)) {
    if (claudeResult(request, CLAUDE_WRITE_ID) === undefined) throw new E2eProtocolError("$.messages", "parent history was not restored", "subagents");
    if (claudeResult(request, CLAUDE_RESUME_ID) === undefined) {
      if (!text.includes("execution ended before delivering a result")) throw new E2eProtocolError("$.messages", "child interruption was not delivered at parent resume", "subagents");
      return claudeResponse("parent-resume-request-write", "tool_use", [{
        type: "tool_use", id: CLAUDE_RESUME_ID, name: "Write",
        input: { file_path: resolve(requireInbox(text, repoRoot, "claude"), "resume.md"), content: resumeBody() },
      }]);
    }
    return claudeResponse(text.includes(NEXT_REPLY) ? "parent-received-resumed-reply" : "parent-recovery-waiting", "end_turn", [{
      type: "text", text: text.includes(NEXT_REPLY) ? RECOVERY_PARENT_REPLY : "Waiting for the resumed child.",
    }]);
  }
  if (recovery && !text.includes(PARENT_MARKER) && text.includes(CHILD_MARKER)) {
    const progress = claudeResult(request, CLAUDE_PROGRESS_ID);
    if (text.includes(NEXT_MARKER)) {
      if (!progress || progress.is_error) throw new E2eProtocolError("$.messages", "child history was not restored", "subagents");
      return claudeChild(request, mode, true);
    }
    if (!progress) return claudeResponse("child-progress-write", "tool_use", [{
      type: "tool_use", id: CLAUDE_PROGRESS_ID, name: "Write",
      input: { file_path: resolve(repoRoot, "child-progress.txt"), content: CHILD_PROGRESS },
    }]);
    if (progress.is_error) {
      const detail = deepText(progress).toLowerCase();
      const category = ["permission", "read", "path", "denied", "hook", "invalid"].find((item) => detail.includes(item)) ?? "unknown";
      throw new E2eProtocolError("$.messages", `child checkpoint failed (${category})`, "subagents");
    }
    return claudeResponse("child-interruption-ready", "end_turn", [{ type: "text", text: "Interrupted fixture response." }]);
  }
  if (text.includes(PARENT_MARKER)) return claudeParent(request, repoRoot, text, mode, alternateRoot, stopFallback, selection);
  if (text.includes(CHILD_MARKER)) return selectedClaudeChild(request, mode, text.includes(NEXT_MARKER), repoRoot, selection);
  throw new E2eProtocolError("$.messages", "does not select the subagents scenario", "subagents");
}

export function codexTransition(request: OpenAiResponsesRequest, repoRoot: string, mode: "interactive" | "auto" = "interactive", recovery = false, alternateRoot = false, stopFallback = false, selection: SkillSelection = "none"): OpenAiScenarioResponse {
  const text = deepText([request.instructions, request.input]);
  const hasOutput = (id: string) => request.input.some((item) => (item.type === "custom_tool_call_output" || item.type === "function_call_output") && item.call_id === id);
  if (recovery && text.includes(PARENT_MARKER) && text.includes(RECOVERY_MARKER)) {
    if (!hasOutput(CODEX_WRITE_ID)) throw new OpenAiProtocolError("$.input", "parent history was not restored", "subagents");
    if (!hasOutput(CODEX_RESUME_ID)) {
      if (!text.includes("execution ended before delivering a result")) throw new OpenAiProtocolError("$.input", "child interruption was not delivered at parent resume", "subagents");
      const path = resolve(requireInbox(text, repoRoot, "codex"), "resume.md");
      const command = `harness-e2e-request ${Buffer.from(path).toString("base64")} ${Buffer.from(resumeBody()).toString("base64")}`;
      return codexCommand(request, CODEX_RESUME_ID, "parent-resume-request-write", command);
    }
    const ready = text.includes(NEXT_REPLY);
    const checkpoint = ready ? "parent-received-resumed-reply" : "parent-recovery-waiting";
    return { scenario: "subagents", checkpoint, output: finalOutput(checkpoint, ready ? RECOVERY_PARENT_REPLY : "Waiting for the resumed child.") };
  }
  if (recovery && !text.includes(PARENT_MARKER) && text.includes(CHILD_MARKER)) {
    if (text.includes(NEXT_MARKER)) {
      if (!hasOutput(CODEX_PROGRESS_ID)) throw new OpenAiProtocolError("$.input", "child history was not restored", "subagents");
      return codexChild(request, mode, true);
    }
    if (!hasOutput(CODEX_PROGRESS_ID)) {
      const command = `node -e "require('fs').writeFileSync('child-progress.txt',Buffer.from('${Buffer.from(CHILD_PROGRESS).toString("base64")}','base64'))"`;
      return codexCommand(request, CODEX_PROGRESS_ID, "child-progress-write", command);
    }
    return { scenario: "subagents", checkpoint: "child-interruption-ready", output: finalOutput("child-interruption-ready", "Interrupted fixture response.") };
  }
  if (text.includes(PARENT_MARKER)) return codexParent(request, repoRoot, text, mode, alternateRoot, stopFallback, selection);
  if (text.includes(CHILD_MARKER)) return selectedCodexChild(request, mode, text.includes(NEXT_MARKER), repoRoot, selection);
  throw new OpenAiProtocolError("$.input", "does not select the subagents scenario", "subagents");
}

function resumeBody(): string {
  return `---\nresume: agent-1\n---\n${NEXT_MARKER}\nContinue the interrupted work.\n`;
}

function codexCommand(request: OpenAiResponsesRequest, id: string, checkpoint: string, command: string): OpenAiScenarioResponse {
  const input = { cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 };
  return { scenario: "subagents", checkpoint, output: request.codeMode
    ? { type: "custom_tool_call", id: `ctc_${id}`, call_id: id, name: "exec", status: "completed", input: `const result = await tools.exec_command(${JSON.stringify(input)}); text(JSON.stringify(result));` }
    : { type: "function_call", id: `fc_${id}`, call_id: id, name: "exec_command", status: "completed", arguments: JSON.stringify(input) } };
}

function claudeParent(request: AnthropicMessagesRequest, repoRoot: string, text: string, mode: "interactive" | "auto", alternateRoot: boolean, stopFallback: boolean, selection: SkillSelection): AnthropicScenarioResponse {
  const activation = claudeResult(request, CLAUDE_ENABLE_ID);
  if (!activation) {
    if (existsSync(resolve(repoRoot, "..", "state", "inboxes"))) throw new E2eProtocolError("$.messages", "inbox existed before activation", "subagents");
    return claudeResponse("parent-inbox-enable", "tool_use", [{
      type: "tool_use", id: CLAUDE_ENABLE_ID, name: "Bash",
      input: { command: `${process.platform === "win32" ? "python" : "python3"} ".claude/skills/subagents-toolkit/scripts/enable_inbox.py"` },
    }]);
  }
  const result = claudeResult(request, CLAUDE_WRITE_ID);
  if (result === undefined) {
    const inbox = requireInbox(deepText(activation), repoRoot, "claude");
    if (!request.tools.some((tool) => tool.name === "Bash")) {
      throw new E2eProtocolError("$.tools", "Bash is unavailable", "subagents");
    }
    return claudeResponse("parent-request-write", "tool_use", [{
      type: "tool_use",
      id: CLAUDE_WRITE_ID,
      name: "Bash",
      input: { command: `harness-e2e-request ${Buffer.from(resolve(inbox, "child.md")).toString("base64")} ${Buffer.from(requestBody(mode, alternateRoot, selection)).toString("base64")}` },
    }]);
  }
  if (selection === "missing" && text.includes("missing-e2e") && text.includes("unavailable")) {
    return claudeResponse("parent-received-failure", "end_turn", [{ type: "text", text: PARENT_REPLY }]);
  }
  if (text.includes(CHILD_REPLY)) {
    return claudeResponse("parent-received-reply", "end_turn", [{ type: "text", text: PARENT_REPLY }]);
  }
  if (!stopFallback) requireRequestFile(text, repoRoot, "claude");
  return claudeResponse("parent-waiting", "end_turn", [{ type: "text", text: "Waiting for the delegated agent." }]);
}

function claudeChild(request: AnthropicMessagesRequest, mode: "interactive" | "auto", continuing: boolean): AnthropicScenarioResponse {
  const checkpoint = continuing ? "child-resume-complete" : "child-complete";
  const reply = continuing ? NEXT_REPLY : CHILD_REPLY;
  if (mode === "auto") return claudeResponse(checkpoint,"end_turn",[{ type:"text",text:reply }]);
  const id = continuing ? `${CLAUDE_REPLY_ID}_resume` : CLAUDE_REPLY_ID;
  const result = claudeResult(request, id);
  if (result === undefined) {
    if (!request.tools.some((tool) => tool.name === "Bash")) {
      throw new E2eProtocolError("$.tools", "Bash is unavailable to arm the child reply", "subagents");
    }
    return claudeResponse(continuing ? "child-resume-reply-armed" : "child-reply-armed", "tool_use", [{
      type: "tool_use", id, name: "Bash", input: { command: "harness reply", description: "Reply to the parent agent" },
    }]);
  }
  if (result.is_error === true || !deepText(result).includes("next successful Stop will reply to the parent")) {
    throw new E2eProtocolError("$.messages", "harness reply did not arm the child Stop", "subagents");
  }
  return claudeResponse(checkpoint, "end_turn", [{ type: "text", text: reply }]);
}

function codexParent(request: OpenAiResponsesRequest, repoRoot: string, text: string, mode: "interactive" | "auto", alternateRoot: boolean, stopFallback: boolean, selection: SkillSelection): OpenAiScenarioResponse {
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  const activation = outputs.find((item) => item.call_id === CODEX_ENABLE_ID);
  if (!activation) {
    if (existsSync(resolve(repoRoot, "..", "state", "inboxes"))) throw new OpenAiProtocolError("$.input", "inbox existed before activation", "subagents");
    return codexCommand(request, CODEX_ENABLE_ID, "parent-inbox-enable", `${process.platform === "win32" ? "python" : "python3"} ".agents/skills/subagents-toolkit/scripts/enable_inbox.py"`);
  }
  if (!outputs.some((item) => item.call_id === CODEX_WRITE_ID)) {
    const inbox = requireInbox(deepText(activation), repoRoot, "codex");
    const offered = request.tools.map((tool) => String(tool.name ?? tool.type ?? "unknown"));
    if (!request.codeMode && !offered.includes("exec_command")) {
      throw new OpenAiProtocolError("$.tools", `exec_command is unavailable; offered: ${offered.join(", ")}`, "subagents");
    }
    const requestPath = resolve(inbox, "child.md");
    const command = `harness-e2e-request ${Buffer.from(requestPath).toString("base64")} ${Buffer.from(requestBody(mode, alternateRoot, selection)).toString("base64")}`;
    const output: OpenAiResponseOutput = request.codeMode
      ? {
          type: "custom_tool_call",
          id: "ctc_e2e_subagents_request",
          call_id: CODEX_WRITE_ID,
          name: "exec",
          status: "completed",
          input: `const result = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 })}); text(JSON.stringify(result));`,
        }
      : {
          type: "function_call",
          id: "fc_e2e_subagents_request",
          call_id: CODEX_WRITE_ID,
          name: "exec_command",
          status: "completed",
          arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 }),
        };
    return { scenario: "subagents", checkpoint: "parent-request-write", output };
  }
  if (selection === "missing" && text.includes("missing-e2e") && text.includes("unavailable")) {
    return { scenario: "subagents", checkpoint: "parent-received-failure", output: finalOutput("parent-received-failure", PARENT_REPLY) };
  }
  if (text.includes(CHILD_REPLY)) {
    return { scenario: "subagents", checkpoint: "parent-received-reply", output: finalOutput("parent-received-reply", PARENT_REPLY) };
  }
  if (!stopFallback) requireRequestFile(text, repoRoot, "codex");
  return { scenario: "subagents", checkpoint: "parent-waiting", output: finalOutput("parent-waiting", "Waiting for the delegated agent.") };
}

function codexChild(request: OpenAiResponsesRequest, mode: "interactive" | "auto", continuing: boolean): OpenAiScenarioResponse {
  const checkpoint = continuing ? "child-resume-complete" : "child-complete";
  const reply = continuing ? NEXT_REPLY : CHILD_REPLY;
  if (mode === "auto") return { scenario:"subagents",checkpoint,output:finalOutput(checkpoint,reply) };
  const id = continuing ? `${CODEX_REPLY_ID}_resume` : CODEX_REPLY_ID;
  const outputs = request.input.filter((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
  const result = outputs.find((item) => item.call_id === id);
  if (result === undefined) {
    const command = "harness reply";
    const output: OpenAiResponseOutput = request.codeMode
      ? {
          type: "custom_tool_call", id: "ctc_e2e_subagents_reply", call_id: id, name: "exec", status: "completed",
          input: `const result = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 })}); text(JSON.stringify(result));`,
        }
      : {
          type: "function_call", id: "fc_e2e_subagents_reply", call_id: id, name: "exec_command", status: "completed",
          arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 }),
        };
    return { scenario: "subagents", checkpoint: continuing ? "child-resume-reply-armed" : "child-reply-armed", output };
  }
  if (!deepText(result).includes("next successful Stop will reply to the parent")) {
    throw new OpenAiProtocolError("$.input", "harness reply did not arm the child Stop", "subagents");
  }
  return { scenario: "subagents", checkpoint, output: finalOutput(checkpoint, reply) };
}

function requireInbox(text: string, repoRoot: string, provider: "claude" | "codex"): string {
  const decoded = text.replaceAll("\\\\", "\\");
  for (const match of decoded.matchAll(/((?:[A-Za-z]:[\\/]|\/)[^\r\n"'`]*?[\\/]inboxes[\\/][a-z0-9]{6})/gu)) {
    const inbox = match[1]!;
    if (!isAbsolute(inbox)) continue;
    try {
      const canonicalInbox = realpathSync(inbox);
      if (containsPath(realpathSync(resolve(repoRoot,"..","state","inboxes")), canonicalInbox)) return canonicalInbox;
    } catch { /* the inbox must exist before the model can write its request */ }
  }
  if (provider === "claude") throw new E2eProtocolError("$.messages", "missing a contained delegation inbox", "subagents");
  throw new OpenAiProtocolError("$.input", "missing a contained delegation inbox", "subagents");
}

function requireRequestFile(text: string, repoRoot: string, provider: "claude" | "codex"): void {
  const inbox = requireInbox(text, repoRoot, provider);
  if (!existsSync(resolve(inbox,"child.md")) && !existsSync(resolve(inbox,"child.md.running"))) return;
  if (provider === "claude") throw new E2eProtocolError("$.messages", "request was not deleted after startup", "subagents");
  throw new OpenAiProtocolError("$.input", "request was not deleted after startup", "subagents");
}

function requestBody(mode: "interactive" | "auto", alternateRoot: boolean, selection: SkillSelection): string {
  return `---\nmode: ${mode}\n${selection === "none" ? "" : `skill: ${selection === "found" ? "e2e-selected" : "missing-e2e"}\n`}${alternateRoot ? "root: ../worktree\n" : ""}---\n\n${CHILD_MARKER}\nInspect the deterministic delegated task and explicitly reply to the parent.\n`;
}

function claudeResult(request: AnthropicMessagesRequest, id: string): Record<string, unknown> | undefined {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_result" && block.tool_use_id === id) return block;
    }
  }
  return undefined;
}

function claudeResponse(checkpoint: string, stopReason: "tool_use" | "end_turn", content: readonly Record<string, unknown>[]): AnthropicScenarioResponse {
  return { scenario: "subagents", checkpoint, messageId: stableId(`claude:${checkpoint}`), stopReason, content };
}

function finalOutput(checkpoint: string, text: string): OpenAiResponseOutput {
  return { type: "message", id: stableId(`codex:${checkpoint}`), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
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
  return `msg_e2e_${createHash("sha256").update(`subagents:${value}`).digest("hex").slice(0, 20)}`;
}

function selectedClaudeChild(request: AnthropicMessagesRequest, mode: "interactive" | "auto", continuing: boolean, root: string, selection: SkillSelection): AnthropicScenarioResponse {
  if (!continuing) {
    const loaded = deepText(request.messages).includes(SKILL_RESOURCE);
    if (loaded !== (selection === "found")) throw new E2eProtocolError("$.messages", "native child skill resource selection differs", "subagents");
    if (selection === "found" && !claudeResult(request, "toolu_skill_receipt")) {
      return claudeResponse("child-skill-receipt", "tool_use", [{ type: "tool_use", id: "toolu_skill_receipt", name: "Write", input: { file_path: resolve(root, SKILL_RECEIPT), content: JSON.stringify({ skill: "e2e-selected" }) } }]);
    }
  }
  return claudeChild(request, mode, continuing);
}

function selectedCodexChild(request: OpenAiResponsesRequest, mode: "interactive" | "auto", continuing: boolean, root: string, selection: SkillSelection): OpenAiScenarioResponse {
  if (!continuing) {
    const loaded = deepText(request.input).includes(SKILL_RESOURCE);
    if (loaded !== (selection === "found")) throw new OpenAiProtocolError("$.input", "native child skill resource selection differs", "subagents");
    if (selection === "found" && !request.input.some((item) => item.call_id === "call_skill_receipt" && (item.type === "custom_tool_call_output" || item.type === "function_call_output"))) {
      return codexCommand(request, "call_skill_receipt", "child-skill-receipt", `node -e "require('fs').writeFileSync('${SKILL_RECEIPT}',JSON.stringify({skill:'e2e-selected'}))"`);
    }
  }
  return codexChild(request, mode, continuing);
}
