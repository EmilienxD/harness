import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "../../harness/pi-transport/transport.ts";

const STATE = "harness-desktop-notification-v1";
const helper = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "harness", "desktop_notification_pi.py");
const preview = (text: string, limit: number) => {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : normalized.slice(0, limit - 1) + "…";
};

export default function (pi: any): void {
  let controller = new AbortController();
  let running = false;
  const reset = () => { controller.abort(); controller = new AbortController(); running = false; };
  pi.on("session_start", reset);
  pi.on("session_shutdown", () => { controller.abort(); running = false; });
  pi.on("agent_start", () => { running = true; });
  const display = (content: string) => pi.sendMessage({ customType: STATE, content, display: true }, { triggerTurn: false });
  const enabled = (ctx: any) => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Preferences belong to the entire native session, including other tree branches.
    // A fork copies entries but gets a new ID, so it starts with notifications disabled.
    const entries = ctx.sessionManager.getEntries().filter((entry: any) =>
      entry.type === "custom" && entry.customType === STATE && entry.data?.sessionId === sessionId);
    return entries.at(-1)?.data.enabled === true;
  };
  const request = async (operation: string, ctx: any, extra = {}) => {
    const result = await requestPython({ version: 1, operation, cwd: ctx.cwd, ...extra }, controller.signal, helper, 15_000);
    if (typeof result.ok !== "boolean") throw new Error("Pi notification protocol mismatch");
    return result.ok;
  };
  const command = async (args: string, ctx: any) => {
    const argument = args.trim();
    if (argument !== "" && argument !== "--disable") { display("Usage: /enable-desktop-notification [--disable]"); return; }
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) { display("Cannot enable notifications: session ID is unavailable."); return; }
    const signal = controller.signal;
    try {
      const enable = argument !== "--disable";
      if (enable && !await request("available", ctx)) { display("Cannot enable notifications: no desktop notification backend is available."); return; }
      if (signal.aborted) return;
      pi.appendEntry(STATE, { sessionId, enabled: enable });
      display(`Desktop notifications ${enable ? "enabled" : "disabled"} for this session.`);
    } catch { if (!signal.aborted) display("Desktop notification command failed. Check the Python runtime and native notification backend."); }
  };
  pi.registerCommand("enable-desktop-notification", {
    description: "Enable desktop notifications for this Pi session (--disable turns them off)", handler: command,
  });
  pi.on("agent_settled", async (event: any, ctx: any) => {
    if (!running) return;
    running = false;
    if (!enabled(ctx)) return;
    const assistant = ctx.sessionManager.getBranch().filter((entry: any) =>
      entry.type === "message" && entry.message.role === "assistant").at(-1)?.message;
    const text = (assistant?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
    const body = event.aborted ? "Turn aborted." : assistant?.stopReason === "error" ? "Turn failed." : preview(text, 240) || "Turn completed.";
    const title = `Pi: ${preview(pi.getSessionName() || ctx.sessionManager.getSessionId(), 64)}`;
    const signal = controller.signal;
    try {
      if (!await request("notify", ctx, { title, body }) && !signal.aborted) display("Desktop notification delivery failed. Check the native notification backend.");
    } catch { if (!signal.aborted) display("Desktop notification delivery failed. Check the Python runtime and native notification backend."); }
  });
}
