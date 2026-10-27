import { createHash } from "node:crypto";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export type Route = "auto" | "interactive";
export const parentMarker = (route: Route) => `[E2E:pi-subagents:parent:${route}]`;
export const childMarker = (route: Route) => `[E2E:pi-subagents:child:${route}]`;
export const childAnswer = (route: Route) => `Child answer for ${route} 雪.`;
export const parentDone = (route: Route) => `Parent integrated the ${route} child result.`;
export const REQUEST_FILE = "child-request.md";
export const BUSY_MARKER = "[E2E:pi-subagents:busy]";
export const BUSY_COMMAND = "node busy-parent.cjs";
const NAME = "pi-subagents";

export const requestBody = (route: Route, explicitModel = false, childProvider = "pi", skill: "none" | "found" | "missing" = "none") =>
  `---\nmode: ${route}\n${skill === "none" ? "" : `skill: ${skill === "found" ? "e2e-selected" : "missing-e2e"}\n`}${explicitModel ? `provider: ${childProvider}\nmodel: gpt-6.1-sol\neffort: medium\n` : ""}---\n${childMarker(route)} Reply with your answer.`;

export const roundPayload = {
  questions: [{
    id: "Q1", question: "Fixture decision", explanation_html: "<p>Delegated preview received.</p>", recommendation: "A",
    options: [{ letter: "A", label: "Keep", detail: "Keep the preview" }, { letter: "B", label: "Change", detail: "Revise the preview" }],
  }],
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (typeof value === "object" && value !== null && "text" in value) return text((value as { text: unknown }).text);
  if (typeof value === "object" && value !== null && "content" in value) return text((value as { content: unknown }).content);
  return "";
}

const message = (route: string, checkpoint: string, body: string): OpenAiScenarioResponse => ({
  scenario: `${NAME}-${route}`, checkpoint,
  output: { type: "message", id: `msg_harness_subagents_${route}_${checkpoint}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: body, annotations: [] }] },
});

/** The model reads its assigned inbox from context, exactly as a real parent would. */
function inbox(request: OpenAiResponsesRequest): string {
  const context = [text(request.instructions), ...request.input.map(text)].join("\n");
  const match = /assigned inbox `([^`\r\n]+)`/u.exec(context);
  if (!match) throw new OpenAiProtocolError("$.instructions", "the subagents inbox was not supplied", NAME);
  return match[1]!;
}

export function subagentsScenario(options: { explicitModel?: boolean; grilling?: boolean; childProvider?: "pi" | "chatgpt"; shellWrite?: boolean; failedWrite?: boolean; busyParent?: boolean; skill?: "none" | "found" | "missing" } = {}) {
  return {
    scenarioCatalogHash: createHash("sha256").update(JSON.stringify({ NAME, routes: ["auto", "interactive"], options, version: 2 })).digest("hex"),
    transition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
      const reject = (field: string, detail: string): never => { throw new OpenAiProtocolError(field, detail, NAME); };
      const users = request.input.filter((item) => item.role === "user").map(text);
      const route = (["auto", "interactive"] as const).find((candidate) => users.some((value) => value.includes(parentMarker(candidate))));
      if (route === undefined) {
        const child = (["auto", "interactive"] as const).find((candidate) => users.some((value) => value.includes(childMarker(candidate))));
        if (child === undefined) reject("$.input", "unknown pi-subagents routing marker");
        if (request.model !== (options.explicitModel ? "gpt-6.1-sol" : "pi-e2e")) reject("$.model", "child did not use the requested model");
        const loaded = users.join("\n").includes("[E2E:subagents:loaded-skill]");
        if (loaded !== (options.skill === "found")) reject("$.input", "native child skill resource selection differs");
        const receiptCall = request.input.find((item) => item.type === "function_call" && item.call_id === "call_skill_receipt");
        if (options.skill === "found" && !receiptCall) return {
          scenario: NAME, checkpoint: "child-skill-receipt",
          output: { type: "function_call", id: "fc_skill_receipt", call_id: "call_skill_receipt", name: "write", arguments: JSON.stringify({ path: "selected-skill.json", content: JSON.stringify({ skill: "e2e-selected" }) }), status: "completed" },
        };
        if (options.skill === "found" && !request.input.some((item) => item.type === "function_call_output" && item.call_id === "call_skill_receipt")) reject("$.input", "missing skill receipt tool outcome");
        if (options.skill !== "found" && request.input.some((item) => item.type === "function_call")) reject("$.input", "children answer without tools");
        return message(`child-${child}`, "child-answer", childAnswer(child!));
      }
      if (request.model !== "pi-e2e") reject("$.model", "unexpected parent model");
      const calls = request.input.filter((item) => item.type === "function_call");
      const results = request.input.filter((item) => item.type === "function_call_output");
      const callId = `call_harness_subagents_${route}_write`;
      if (calls.length > (options.grilling || options.busyParent ? 2 : 1) || results.length !== calls.length) reject("$.input", "parent tool history is incomplete");
      const requestPath = `${inbox(request)}${inbox(request).includes("\\") ? "\\" : "/"}${REQUEST_FILE}`;
      const requestContent = requestBody(route, options.explicitModel, options.childProvider, options.skill);
      const tool = options.shellWrite ? (request.tools.some((item) => item.name === "powershell") ? "powershell" : "bash") : "write";
      const command = `node -e "require('fs').writeFileSync(Buffer.from('${Buffer.from(requestPath).toString("base64")}','base64').toString(),Buffer.from('${Buffer.from("\ufeff" + requestContent).toString("base64")}','base64'))"${options.failedWrite ? "; exit 7" : ""}`;
      const input = options.shellWrite ? { command } : { path: requestPath, content: requestContent };
      if (calls.length === 0) {
        if (!request.tools.some((item) => item.type === "function" && item.name === tool)) reject("$.tools", "the request writing tool is not offered");
        return {
          scenario: `${NAME}-${route}`, checkpoint: "parent-write",
          output: { type: "function_call", id: `fc_harness_subagents_${route}`, call_id: callId, name: tool, arguments: JSON.stringify(input), status: "completed" },
        };
      }
      if (calls[0]!.call_id !== callId || results[0]!.call_id !== callId || calls[0]!.name !== tool) reject("$.input", "unknown parent tool identity");
      const written = JSON.parse(String(calls[0]!.arguments));
      if (JSON.stringify(written) !== JSON.stringify(input)) reject("$.input", "unexpected delegation request mutation");
      if (options.skill === "missing") {
        if (!JSON.stringify(results).includes("missing-e2e") || !JSON.stringify(results).includes("unavailable")) reject("$.input", "missing skill failure was not delivered");
        return message(route, "parent-received-failure", parentDone(route));
      }
      const delivered = request.input.slice(request.input.indexOf(results[0]!) + 1).some((item) => text(item).includes(childAnswer(route)));
      if (options.busyParent && users.some((value) => value.includes(BUSY_MARKER))) {
        const shell = request.tools.some((item) => item.name === "powershell") ? "powershell" : "bash";
        if (calls.length === 1) {
          if (delivered) reject("$.input", "child result arrived before the parent became busy");
          return {
            scenario: NAME, checkpoint: "parent-busy-tool",
            output: { type: "function_call", id: "fc_busy", call_id: "call_busy", name: shell, arguments: JSON.stringify({ command: BUSY_COMMAND }), status: "completed" },
          };
        }
        if (calls[1]!.call_id !== "call_busy" || results[1]!.call_id !== "call_busy" || calls[1]!.name !== shell
          || JSON.parse(String(calls[1]!.arguments)).command !== BUSY_COMMAND) reject("$.input", "unknown busy parent tool");
        if (!delivered) reject("$.input", "the first model request after the busy tool did not receive the child result");
      }
      if (options.grilling && delivered) {
        const source = users.join("\n").split("\n").map((line) => line.trim()).find((line) => /[\\/]round-\d{3}\.json$/u.test(line));
        if (!source) reject("$.input", "cloud round path missing in combined workflow");
        if (calls.length === 1) {
          return {
            scenario: NAME, checkpoint: "publish-delegated-preview",
            output: { type: "function_call", id: "fc_combined_round", call_id: "call_combined_round", name: "write", arguments: JSON.stringify({ path: source, content: JSON.stringify(roundPayload) }), status: "completed" },
          };
        }
        if (calls[1]!.call_id !== "call_combined_round" || results[1]!.call_id !== "call_combined_round" || calls[1]!.name !== "write") reject("$.input", "unknown round tool identity");
        const round = JSON.parse(String(calls[1]!.arguments));
        if (round.path !== source || round.content !== JSON.stringify(roundPayload)) reject("$.input", "unexpected round mutation");
      }
      return delivered ? message(route, "parent-integrated", parentDone(route)) : message(route, "parent-waiting", `Waiting for agent-1 (${route}).`);
    },
  };
}

export const scenario = subagentsScenario();
