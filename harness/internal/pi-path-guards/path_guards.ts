import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "../pi-transport/transport.ts";

const RECEIPT = "harness-path-guard-v1";
const helper = join(dirname(fileURLToPath(import.meta.url)), "path_guards.py");

/** Native event translation only; Python owns matching and guidance policy. */
export function registerPathGuard(pi: any, packageName: string): void {
  let controller = new AbortController();
  const notices = new Map<string, string>();
  const denials = new Map<string, any>();
  const reset = () => { controller.abort(); controller = new AbortController(); notices.clear(); denials.clear(); };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => controller.abort());
  // Denied calls emit execution-end, but Pi does not invoke tool_result for them.
  pi.on("tool_execution_end", (event: any) => {
    const denial = denials.get(event.toolCallId);
    denials.delete(event.toolCallId);
    const text = (event.result?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
    if (denial && event.isError && text.includes(denial.message)) pi.appendEntry(RECEIPT, {
      package: packageName, phase: "call", callId: event.toolCallId, parentCallId: event.parentToolCallId,
      launchArgv: denial.launchArgv, receipts: denial.receipts,
    });
  });

  const handle = async (event: any, ctx: any, phase: "call" | "result") => {
    if (!["read", "write", "edit", "bash", "powershell"].includes(event.toolName)) return;
    if (phase === "call" && (packageName !== "on-edit-block" || !["write", "edit", "bash", "powershell"].includes(event.toolName))) return;
    const text = (event.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
    const branch = ctx.sessionManager.getBranch();
    const entries = branch.filter((entry: any) => entry.type === "custom" && entry.customType === RECEIPT);
    if (entries.some((entry: any) => entry.data.package === packageName && entry.data.callId === event.toolCallId && entry.data.phase === phase)) return;
    const receipts = entries.flatMap((entry: any) => entry.data.receipts ?? []);
    try {
      const response = await requestPython({
        version: 1, package: packageName, phase, cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
        anchor: ctx.sessionManager.getLeafId(), callId: event.toolCallId, parentCallId: event.parentToolCallId,
        tool: event.toolName, input: event.input, isError: event.isError ?? false,
        text,
        details: event.details, receipts,
      }, controller.signal, helper);
      if (typeof response.block !== "boolean" || typeof response.message !== "string" || !Array.isArray(response.receipts)) throw new Error("Pi guard protocol mismatch");
      // No raw tool arguments or result bodies in durable receipts. Nested calls are captured here too.
      if (response.receipts.length && !response.block) pi.appendEntry(RECEIPT, {
        package: packageName, phase, callId: event.toolCallId, parentCallId: event.parentToolCallId,
        launchArgv: response.launchArgv, receipts: response.receipts,
      });
      if (phase === "call" && response.block) {
        denials.set(event.toolCallId, response);
        return { block: true, reason: response.message };
      }
      if (phase === "call" && response.message) notices.set(event.toolCallId, response.message);
      const message = [notices.get(event.toolCallId), response.message].filter(Boolean).join("\n");
      if (phase === "result") notices.delete(event.toolCallId);
      if (message && phase === "result") return {
        content: [...event.content, { type: "text", text: message }],
        structuredContent: event.structuredContent,
      };
    } catch {
      if (phase === "call") return { block: true, reason: "Harness Pi path guard failed. Fix the extension or Python runtime before retrying." };
      return {
        content: [...event.content, { type: "text", text: "Harness Pi reminder failed; check the policy and Python runtime." }],
        structuredContent: event.structuredContent,
      };
    }
  };
  pi.on("tool_call", (event: any, ctx: any) => handle(event, ctx, "call"));
  pi.on("tool_result", (event: any, ctx: any) => handle(event, ctx, "result"));
}
