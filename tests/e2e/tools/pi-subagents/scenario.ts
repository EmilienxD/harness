import { createHash } from "node:crypto";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export type Route = "auto" | "interactive";
export const parentMarker = (route: Route) => `[E2E:pi-subagents:parent:${route}]`;
export const childMarker = (route: Route) => `[E2E:pi-subagents:child:${route}]`;
export const childAnswer = (route: Route) => `Child answer for ${route} 雪.`;
export const parentDone = (route: Route) => `Parent integrated the ${route} child result.`;
export const REQUEST_FILE = "child-request.md";
const NAME = "pi-subagents";

export const requestBody = (route: Route, explicitModel = false, childProvider = "pi") =>
  `---\ntask: general\nmode: ${route}\n${explicitModel ? `provider: ${childProvider}\nmodel: gpt-6.1-sol\neffort: medium\n` : ""}---\n${childMarker(route)} Reply with your answer.`;

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

export function subagentsScenario(options: { explicitModel?: boolean; grilling?: boolean; childProvider?: "pi" | "chatgpt" } = {}) {
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
        if (request.input.some((item) => item.type === "function_call")) reject("$.input", "children answer without tools");
        return message(`child-${child}`, "child-answer", childAnswer(child!));
      }
      if (request.model !== "pi-e2e") reject("$.model", "unexpected parent model");
      const calls = request.input.filter((item) => item.type === "function_call");
      const results = request.input.filter((item) => item.type === "function_call_output");
      const callId = `call_harness_subagents_${route}_write`;
      if (calls.length > (options.grilling ? 2 : 1) || results.length !== calls.length) reject("$.input", "parent tool history is incomplete");
      const requestPath = `${inbox(request)}${inbox(request).includes("\\") ? "\\" : "/"}${REQUEST_FILE}`;
      const requestContent = requestBody(route, options.explicitModel, options.childProvider);
      if (calls.length === 0) {
        if (!request.tools.some((tool) => tool.type === "function" && tool.name === "write")) reject("$.tools", "the native write tool is not offered");
        return {
          scenario: `${NAME}-${route}`, checkpoint: "parent-write",
          output: { type: "function_call", id: `fc_harness_subagents_${route}`, call_id: callId, name: "write", arguments: JSON.stringify({ path: requestPath, content: requestContent }), status: "completed" },
        };
      }
      if (calls[0]!.call_id !== callId || results[0]!.call_id !== callId || calls[0]!.name !== "write") reject("$.input", "unknown parent tool identity");
      const written = JSON.parse(String(calls[0]!.arguments));
      if (written.path !== requestPath || written.content !== requestContent) reject("$.input", "unexpected delegation request mutation");
      const delivered = request.input.slice(request.input.indexOf(results[0]!) + 1).some((item) => text(item).includes(childAnswer(route)));
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
