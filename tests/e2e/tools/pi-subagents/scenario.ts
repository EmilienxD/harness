import { createHash } from "node:crypto";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export type Route = "auto" | "interactive";
export const parentMarker = (route: Route) => `[E2E:pi-subagents:parent:${route}]`;
export const childMarker = (route: Route) => `[E2E:pi-subagents:child:${route}]`;
export const childAnswer = (route: Route) => `Child answer for ${route} 雪.`;
export const parentDone = (route: Route) => `Parent integrated the ${route} child result.`;
export const REQUEST_FILE = "child-request.md";
const NAME = "pi-subagents";

export const requestBody = (route: Route) =>
  `---\ntask: general\nmode: ${route}\n---\n${childMarker(route)} Reply with your answer.`;

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

export const scenario = {
  scenarioCatalogHash: createHash("sha256").update(JSON.stringify({ NAME, routes: ["auto", "interactive"], version: 1 })).digest("hex"),
  transition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
    const reject = (field: string, detail: string): never => { throw new OpenAiProtocolError(field, detail, NAME); };
    if (request.model !== "pi-e2e") reject("$.model", "unexpected fixture model");
    const users = request.input.filter((item) => item.role === "user").map(text);
    const route = (["auto", "interactive"] as const).find((candidate) => users.some((value) => value.includes(parentMarker(candidate))));
    if (route === undefined) {
      const child = (["auto", "interactive"] as const).find((candidate) => users.some((value) => value.includes(childMarker(candidate))));
      if (child === undefined) reject("$.input", "unknown pi-subagents routing marker");
      if (request.input.some((item) => item.type === "function_call")) reject("$.input", "children answer without tools");
      return message(`child-${child}`, "child-answer", childAnswer(child!));
    }
    const calls = request.input.filter((item) => item.type === "function_call");
    const results = request.input.filter((item) => item.type === "function_call_output");
    const callId = `call_harness_subagents_${route}_write`;
    if (calls.length > 1 || results.length !== calls.length) reject("$.input", "parent tool history is incomplete");
    if (calls.length === 0) {
      if (!request.tools.some((tool) => tool.type === "function" && tool.name === "write")) reject("$.tools", "the native write tool is not offered");
      const path = `${inbox(request)}${inbox(request).includes("\\") ? "\\" : "/"}${REQUEST_FILE}`;
      return {
        scenario: `${NAME}-${route}`, checkpoint: "parent-write",
        output: { type: "function_call", id: `fc_harness_subagents_${route}`, call_id: callId, name: "write", arguments: JSON.stringify({ path, content: requestBody(route) }), status: "completed" },
      };
    }
    if (calls[0]!.call_id !== callId || results[0]!.call_id !== callId || calls[0]!.name !== "write") reject("$.input", "unknown parent tool identity");
    const delivered = request.input.slice(request.input.indexOf(results[0]!) + 1).some((item) => text(item).includes(childAnswer(route)));
    return delivered ? message(route, "parent-integrated", parentDone(route)) : message(route, "parent-waiting", `Waiting for agent-1 (${route}).`);
  },
};
