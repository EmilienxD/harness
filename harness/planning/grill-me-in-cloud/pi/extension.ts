import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { requestPython } from "../../harness/pi-transport/transport.ts";
import { GrillRelay, RECEIPT } from "../../harness/grill-cloud/relay.ts";

const support = join(dirname(fileURLToPath(import.meta.url)), "../../harness");

export default function (pi: any) {
  let controller = new AbortController();
  let relay: GrillRelay | undefined;
  let source: string | undefined;
  let pendingContext = "";
  let needsLocations = false;
  const active = (ctx: any) => ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === RECEIPT && ["start", "stop"].includes(entry.data?.phase) && entry.data.sessionId === ctx.sessionManager.getSessionId()).at(-1)?.data.phase === "start";
  const stop = () => { controller.abort(); controller = new AbortController(); relay?.stop(); relay = undefined; source = undefined; pendingContext = ""; needsLocations = false; };
  const request = async (operation: string, ctx: any, initial = false) => {
    const signal = controller.signal;
    const result = await requestPython({ version: 1, operation, initial, cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(), title: pi.getSessionName() ?? "",
      sessionFile: ctx.sessionManager.getSessionFile(), anchor: ctx.sessionManager.getLeafId(),
      branchIds: ctx.sessionManager.getBranch().map((entry: any) => entry.id),
    }, signal, join(support, "grill_cloud_pi.py"), 120_000);
    if (signal.aborted) throw new Error("Pi grill cancelled");
    if (typeof result.ok !== "boolean" || typeof result.message !== "string") throw new Error("Pi grill protocol mismatch");
    if (typeof result.source === "string") source = result.source;
    if (result.ok) {
      if (result.published) pi.appendEntry(RECEIPT, { phase: "round", roundId: result.published.round_id, sessionId: ctx.sessionManager.getSessionId() });
      if (!relay) {
        try { relay = new GrillRelay(pi, ctx, result.relay); relay.wake(); }
        catch { /* Retry relay initialization on the next operation. */ }
      }
    }
    return result;
  };
  pi.on("session_shutdown", stop);
  pi.on("session_start", async (_event: any, ctx: any) => {
    stop();
    if (active(ctx)) {
      try { const result = await request("prepare", ctx); if (result.ok) pendingContext = result.message; }
      catch { /* Preparation retries before the next user turn. */ }
    }
  });
  pi.on("session_tree", (_event: any, ctx: any) => {
    stop();
    needsLocations = true;
    // Pi persists the selected leaf on the next append. Pin it now so restart cannot restore
    // the previous leaf and make an abandoned publication eligible for recovery again.
    if (ctx.sessionManager.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === RECEIPT && entry.data?.sessionId === ctx.sessionManager.getSessionId())) {
      pi.appendEntry(RECEIPT, { phase: "branch", sessionId: ctx.sessionManager.getSessionId() });
    }
  });
  pi.on("input", async (event: any, ctx: any) => {
    const match = /^\/(?:skill:)?grill-me-in-cloud(?:\s+([\s\S]*))?$/.exec(event.text.trim());
    if (!match) return;
    if (!ctx.isIdle()) { ctx.ui.notify("Wait for the active turn to finish before starting a cloud interview.", "error"); return { action: "handled" }; }
    if (!pi.getCommands().some((command: any) => command.source === "skill" && command.name === "skill:grill-me-in-cloud")) {
      ctx.ui.notify("The grill-me-in-cloud skill is unavailable. Reinstall the package and reload Pi.", "error"); return { action: "handled" };
    }
    try {
      const result = await request("prepare", ctx, true);
      pendingContext = "";
      needsLocations = false;
      if (!result.ok) { ctx.ui.notify(result.message, "error"); return { action: "handled" }; }
      pi.appendEntry(RECEIPT, { phase: "start", sessionId: ctx.sessionManager.getSessionId() });
      return { action: "transform", text: `/skill:grill-me-in-cloud ${match[1] ?? ""}\n\n${result.message}`, images: event.images };
    } catch { ctx.ui.notify("Pi grill preparation failed.", "error"); return { action: "handled" }; }
  });
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (event.messageType !== "user" || !active(ctx)) return;
    // Prepared paths travel with the actual input, rather than a pending flag another extension can strand.
    if (source && typeof event.prompt === "string" && event.prompt.includes(source)) return;
    try {
      const result = await request("prepare", ctx, needsLocations);
      if (result.ok) needsLocations = false;
      const content = [pendingContext, result.message].filter(Boolean).join("\n");
      pendingContext = "";
      if (content) return { message: { customType: "harness-grill-context", content, display: false } };
    } catch { return { message: { customType: "harness-grill-context", content: "Pi grill preparation failed.", display: false } }; }
  });
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (event.isError || !active(ctx) || !source || !existsSync(source)) return;
    try {
      const result = await request("publish", ctx);
      return { content: [...event.content, { type: "text", text: result.message }], structuredContent: event.structuredContent };
    } catch { return { content: [...event.content, { type: "text", text: "Pi grill publication failed." }], structuredContent: event.structuredContent }; }
  });
  pi.on("agent_settled", () => relay?.wake());
}
