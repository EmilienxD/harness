import { createHash } from "node:crypto";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "./openai-server.js";

export interface PiScenarioStep {
  readonly checkpoint: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Inspect real tool output in memory only. Throw a structural error on mismatch. */
  readonly verifyResult?: (output: unknown) => void;
}

/** A linear scenario is selected by a routing marker and reconstructed from full tool history. */
export function createPiToolScenario(options: {
  readonly name: string;
  readonly marker: string;
  readonly steps: readonly PiScenarioStep[];
}) {
  const catalogHash = createHash("sha256").update(JSON.stringify({ name: options.name, steps: options.steps.map(({ checkpoint, tool, input }) => ({ checkpoint, tool, input })) })).digest("hex");
  const ids = options.steps.map((_, index) => `call_harness_${catalogHash.slice(0, 12)}_${index}`);
  const transition = (request: OpenAiResponsesRequest): OpenAiScenarioResponse => {
    const reject = (field: string, detail: string): never => { throw new OpenAiProtocolError(field, detail, options.name); };
    if (request.model !== "pi-e2e") reject("$.model", "unexpected fixture model");
    if (!request.input.some((item) => item.role === "user" && text(item.content).includes(options.marker))) reject("$.input", "unknown scenario routing marker");
    const calls = request.input.filter((item) => item.type === "function_call");
    const results = request.input.filter((item) => item.type === "function_call_output");
    if (calls.length !== results.length || calls.length > options.steps.length) reject("$.input", "tool history is incomplete or exceeds the scenario");
    for (let index = 0; index < results.length; index += 1) {
      const call = calls[index]!;
      const result = results[index]!;
      const step = options.steps[index]!;
      if (call.call_id !== ids[index] || result.call_id !== ids[index] || call.name !== step.tool) reject("$.input", "unknown tool identity or ordering");
      if (request.input.indexOf(call) >= request.input.indexOf(result) || (index > 0 && request.input.indexOf(results[index - 1]!) >= request.input.indexOf(call))) reject("$.input", "tool results must follow their call before the next step");
      let argumentsValue: unknown;
      try { argumentsValue = JSON.parse(String(call.arguments)); } catch { reject("$.input", "invalid tool arguments in history"); }
      if (canonical(argumentsValue) !== canonical(step.input)) reject("$.input", "tool arguments differ from the scenario");
      step.verifyResult?.(result.output);
    }
    const step = options.steps[results.length];
    if (!step) return {
      scenario: options.name, checkpoint: "complete",
      output: { type: "message", id: `msg_harness_${catalogHash.slice(0, 12)}_done`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete.\u2028JSONL remains one record.", annotations: [] }] },
    };
    if (!request.tools.some((tool) => tool.type === "function" && tool.name === step.tool)) reject("$.tools", "required native tool is not offered");
    return {
      scenario: options.name, checkpoint: step.checkpoint,
      output: { type: "function_call", id: `fc_harness_${catalogHash.slice(0, 12)}_${results.length}`, call_id: ids[results.length]!, name: step.tool, arguments: JSON.stringify(step.input), status: "completed" },
    };
  };
  return { scenarioCatalogHash: catalogHash, transition };
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (typeof value === "object" && value !== null && "text" in value) return text(value.text);
  return "";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
