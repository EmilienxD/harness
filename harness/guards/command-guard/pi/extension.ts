import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "../../hooks/pi-support/bridge.ts";

const helper = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "hooks", "command_guard_pi.py");

// Native event translation only; the shared Python core owns policy parsing and matching.
export default function (pi: any) {
  let controller = new AbortController();
  const reset = () => { controller.abort(); controller = new AbortController(); };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => controller.abort());

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!["bash", "powershell"].includes(event.toolName)) return;
    const command = event.input?.command;
    if (typeof command !== "string" || !command) return;
    try {
      const response = await requestPython({ version: 1, cwd: ctx.cwd, command }, controller.signal, helper);
      if (typeof response.block !== "boolean" || typeof response.message !== "string") throw new Error("Pi command-guard protocol mismatch");
      if (response.block) return { block: true, reason: response.message };
    } catch {
      // Fail closed: a malformed policy or broken runtime denies the command, matching the hook.
      return { block: true, reason: "Harness command-guard failed; repair the command-guard policy or Python runtime before retrying." };
    }
  });
}
