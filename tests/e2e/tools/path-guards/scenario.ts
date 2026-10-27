import { E2eProtocolError } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError } from "../../core/openai-server.js";

/** Reject unknown identities and incomplete histories without exposing tool payloads. */
export function guardProgress(history: readonly Record<string, unknown>[], limit: number, provider: "claude" | "chatgpt"): number {
  const claude = provider === "claude";
  const calls = history.filter(item => claude ? item.type === "tool_use" : item.type === "function_call" || item.type === "custom_tool_call");
  const results = history.filter(item => claude ? item.type === "tool_result" : item.type === "function_call_output" || item.type === "custom_tool_call_output");
  const reject = () => {
    if (claude) throw new E2eProtocolError("$.messages", "unexpected guard tool history", "shared-path-guards");
    throw new OpenAiProtocolError("$.input", "unexpected guard tool history", "shared-path-guards");
  };
  if (calls.length !== results.length || results.length > limit) reject();
  for (let index = 0; index < results.length; index++) {
    const call = calls[index]!, result = results[index]!;
    const id = `${claude ? "toolu" : "call"}_shared_${index}`;
    if ((claude ? call.id : call.call_id) !== id || (claude ? result.tool_use_id : result.call_id) !== id ||
        history.indexOf(call) >= history.indexOf(result) || (index > 0 && history.indexOf(results[index - 1]!) >= history.indexOf(call))) reject();
  }
  return results.length;
}
