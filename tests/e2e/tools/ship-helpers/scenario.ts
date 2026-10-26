import { createHash } from "node:crypto";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const MARKER = "[E2E:ship-on-demand-helpers]";
export const scenarioCatalogHash = createHash("sha256").update("ship-on-demand-helpers:v1").digest("hex");

/** The real provider shell runs each shipped command; inference never performs effects. */
export function helpersScenario(commands: readonly string[]) {
  return (request: OpenAiResponsesRequest): OpenAiScenarioResponse => {
    const fail = (detail: string): never => { throw new OpenAiProtocolError("$.input", detail, "ship-helpers"); };
    if (!JSON.stringify(request.input).includes(MARKER)) fail("unknown helper journey");
    const outputs = request.input.filter(item => item.type === "custom_tool_call_output" || item.type === "function_call_output");
    if (outputs.length > commands.length) fail("unexpected tool output");
    for (let index = 0; index < outputs.length; index++) {
      const output = outputs[index]!;
      if (output.call_id !== `call_ship_helper_${index}`) fail("unexpected helper ordering");
      const text = JSON.stringify(output.output);
      if (index === 0 && !text.includes("Requirements from fixture")) fail("issue context was not retrieved");
      if (index === 1 && !text.includes("Stub remains unimplemented")) fail("unimplemented stub was not rejected");
      if (index === 3 && !text.includes('"pass"') && !text.includes('\\"pass\\"')) fail("implemented stub was not accepted");
    }
    const index = outputs.length;
    if (index === commands.length) return {
      scenario: "ship-helpers", checkpoint: "complete",
      output: { type: "message", id: "msg_ship_helpers_complete", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Helper checks complete.", annotations: [] }] },
    };
    const id = `call_ship_helper_${index}`;
    const args = { cmd: commands[index], yield_time_ms: 10_000, max_output_tokens: 4_000 };
    return { scenario: "ship-helpers", checkpoint: ["issue-context", "stub-rejected", "implementation", "stub-accepted"][index]!, output: request.codeMode
      ? { type: "custom_tool_call", id: `ctc_${id}`, call_id: id, name: "exec", status: "completed", input: `const result = await tools.exec_command(${JSON.stringify(args)}); text(result.output);` }
      : { type: "function_call", id: `fc_${id}`, call_id: id, name: "exec_command", status: "completed", arguments: JSON.stringify(args) } };
  };
}
