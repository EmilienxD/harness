import { Type } from "typebox";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "../../harness/pi-transport/transport.ts";

const helper = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "harness", "report_gotchas_pi.py");

export default function (pi: any): void {
  let controller = new AbortController();
  const reset = () => { controller.abort(); controller = new AbortController(); };
  pi.on("session_start", reset);
  pi.on("session_shutdown", () => controller.abort());
  pi.registerTool({
    name: "report_gotchas", label: "Report gotchas",
    description: "Submit a consequential implementation caveat to Discord. Read the report-gotchas skill for report format. Identical Markdown is deduplicated for the entire native Pi session.",
    parameters: Type.Object({ message: Type.String({ minLength: 1, description: "Markdown report with a short bold title and concrete caveat; omit secrets and session/Git metadata." }) }),
    outputSchema: Type.Object({ receipt: Type.String(), duplicate: Type.Boolean(), configured: Type.Boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async execute(_id: string, args: { message: string }, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) throw new Error("Pi session identity is unavailable; preserve the caveat in the final response.");
      let result: any;
      try {
        result = await requestPython({ version: 1, operation: "submit", cwd: ctx.cwd, sessionId, message: args.message },
          signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, helper, 20_000);
      } catch {
        throw new Error("Gotcha submission failed. Preserve the caveat in the final response and check the Python runtime and webhook configuration. Retrying identical Markdown is safe.");
      }
      if (!/^[0-9a-f]{32}$/u.test(result.receipt) || typeof result.duplicate !== "boolean" || typeof result.configured !== "boolean")
        throw new Error("Pi gotcha response protocol mismatch; retry identical Markdown or preserve the caveat in the final response.");
      const data = { receipt: result.receipt, duplicate: result.duplicate, configured: result.configured };
      const status = result.duplicate ? "Already submitted in this Pi session." : "Gotcha queued for Discord delivery.";
      const configure = result.configured ? "" : " Configure Discord with harness-report-gotchas configure, then use /report-gotchas-retry.";
      return { content: [{ type: "text", text: `HARNESS_REPORT_GOTCHAS_RECEIPT:${result.receipt}\n${status}${configure}${result.warning ?? ""}` }], details: data, structuredContent: data };
    },
  });
  pi.registerCommand("report-gotchas-retry", {
    description: "Retry queued Discord gotcha reports without inference",
    handler: async (args: string, ctx: any) => {
      let content = "Usage: /report-gotchas-retry";
      if (!args.trim()) {
        try {
          const result = await requestPython({ version: 1, operation: "retry", cwd: ctx.cwd }, controller.signal, helper);
          if (!Number.isInteger(result.scheduled) || result.scheduled < 0) throw new Error("protocol");
          content = `Scheduled ${result.scheduled} queued gotcha report(s) for Discord delivery.`;
        } catch { content = "Could not retry gotchas. Check the Python runtime and configure Discord with harness-report-gotchas configure."; }
      }
      pi.sendMessage({ customType: "harness-report-gotchas-status", content, display: true }, { triggerTurn: false });
    },
  });
}
