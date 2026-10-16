import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { requestCommand } from "../../hooks/pi-transport/transport.ts";

// The uv-installed runtime owns requests, executions and delivery; this file only translates Pi events.
const COMMAND = ["harness-subagents-hook", "--pi"];
const RESULT = "harness-subagents-result";
const NOTICE = "harness-subagents-notice";
const SECTION = "harness-subagents";
const PREVIOUS = "reply-to-agent-with-previous-message";
const PREVIOUS_INVOCATION = new RegExp(`(?<!\\S)/skill:${PREVIOUS}(?=\\s|$)`, "u");
const WRITE_TOOLS = new Set(["write", "edit"]);
const FAILED_STOPS = new Set(["error", "aborted", "length"]);
const MARKER_POLL_MS = 500;
// The marker is only a wake-up hint; the database is rechecked periodically as well.
const DATABASE_POLL_MS = 30_000;

type State = {
  harnessSessionId: string;
  delegatedMode: string | null;
  inbox: string | null;
  instructions: string | null;
  marker: string;
  stopWaitMs: number;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const assistantText = (message: any) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
const assistants = (ctx: any) => ctx.sessionManager.getBranch()
  .filter((entry: any) => entry.type === "message" && entry.message?.role === "assistant").map((entry: any) => entry.message);

/** Match Pi's own write path handling closely enough to recognize the inbox. */
function requestPath(value: unknown, cwd: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let path = value.trim().replace(/^@/u, "");
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) path = homedir() + path.slice(1);
  return resolve(cwd, path);
}

export default function (pi: any): void {
  let controller = new AbortController();
  let state: State | undefined;
  let context: any;
  let timer: NodeJS.Timeout | undefined;
  let stamp = "";
  let lastCheck = 0;
  let ticking = false;
  let inFlight: string | undefined;
  let wake: (() => void) | undefined;

  const notify = (ctx: any, text: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else console.error(text);
  };
  const call = async (operation: string, ctx: any, extra: object = {}, timeout = 30_000) => {
    const result = await requestCommand(COMMAND, {
      version: 1, operation, cwd: ctx.cwd,
      ...(state ? { harnessSessionId: state.harnessSessionId } : {}), ...extra,
    }, controller.signal, timeout);
    if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "Harness subagents bridge failed");
    return result;
  };
  const delivered = (ctx: any, id: string) => ctx.sessionManager.getEntries().some((entry: any) =>
    entry.type === "custom_message" && entry.customType === RESULT && entry.details?.deliveryId === id);
  const live = (ctx: any) => ctx.mode === "tui" || ctx.mode === "rpc";

  const stopWatching = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const reset = () => {
    controller.abort();
    controller = new AbortController();
    stopWatching();
    state = undefined;
    context = undefined;
    inFlight = undefined;
    wake?.();
  };

  /** Acknowledge a result only after Pi has persisted it in this session. */
  const acknowledge = async (ctx: any) => {
    if (!inFlight || !delivered(ctx, inFlight)) return false;
    const id = inFlight;
    inFlight = undefined;
    await call("ack_delivery", ctx, { deliveryId: id });
    return true;
  };

  /** One delivery step for an event-driven parent: replay, deduplicate, or send the next batch. */
  const tick = async (trigger: boolean) => {
    const ctx = context;
    if (ticking || !state || !ctx) return;
    ticking = true;
    lastCheck = Date.now();
    try {
      if (inFlight && !await acknowledge(ctx)) return;
      for (;;) {
        const result = await call("claim_delivery", ctx);
        if (!result.delivery) {
          if (!result.pending) stopWatching();
          return;
        }
        const { id, text } = result.delivery;
        inFlight = id;
        // A replay after reload or restart can already be in the transcript.
        if (await acknowledge(ctx)) continue;
        const message = { customType: RESULT, content: text, display: true, details: { deliveryId: id } };
        // Busy parents read results before their next model call, like Claude/Codex PostToolUse delivery.
        pi.sendMessage(message, ctx.isIdle() ? { triggerTurn: trigger } : { deliverAs: "steer" });
        await acknowledge(ctx);
        return;
      }
    } catch (error) {
      if (!controller.signal.aborted) notify(ctx, `Harness subagents could not deliver a child result: ${errorText(error)}`, "warning");
    } finally {
      ticking = false;
    }
  };

  const markerChanged = async () => {
    if (!state) return false;
    const current = await fs.stat(state.marker).then((info) => `${info.mtimeMs}:${info.size}`, () => "");
    if (current === stamp) return false;
    stamp = current;
    return true;
  };

  const watch = () => {
    if (timer || !context || !live(context)) return;
    timer = setInterval(async () => {
      if (await markerChanged() || inFlight || Date.now() - lastCheck >= DATABASE_POLL_MS) await tick(true);
    }, MARKER_POLL_MS);
    // A watcher must never keep a finished Pi process alive.
    timer.unref();
  };

  /** Headless parents exit after settling, so they wait for their children as Claude's Stop hook does. */
  const waitForResult = (ctx: any) => new Promise<void>((done) => {
    const signal = controller.signal;
    const finish = () => { clearInterval(poll); clearTimeout(limit); wake = undefined; done(); };
    const poll = setInterval(async () => { if (await markerChanged()) finish(); }, MARKER_POLL_MS);
    const limit = setTimeout(finish, DATABASE_POLL_MS);
    wake = finish;
    if (signal.aborted) finish();
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    reset();
    const signal = controller.signal;
    try {
      const result = await call("session_start", ctx, { sessionId: ctx.sessionManager.getSessionId(), reason: event.reason });
      if (signal.aborted) return;
      state = {
        harnessSessionId: result.harnessSessionId, delegatedMode: result.delegatedMode ?? null,
        inbox: result.inbox ?? null, instructions: result.instructions ?? null, marker: result.marker,
        stopWaitMs: Math.max(0, Number(result.stopWaitSeconds ?? 86_400)) * 1000,
      };
      context = ctx;
      stamp = "";
      await markerChanged();
      if (result.recovered) pi.sendMessage({ customType: NOTICE, content: result.recovered, display: true }, { triggerTurn: false });
      // Startup replays pending results into context without starting a turn, like SessionStart context.
      await tick(false);
      if (result.pending || inFlight) watch();
    } catch (error) {
      if (!signal.aborted) notify(ctx, `Harness subagents are unavailable in this session: ${errorText(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    const current = state;
    reset();
    if (!current || event.reason === "reload") return;
    try {
      await requestCommand(COMMAND, { version: 1, operation: "shutdown", cwd: ctx.cwd, harnessSessionId: current.harnessSessionId },
        new AbortController().signal, 10_000);
    } catch {
      // Recovery runs again on the next start; shutdown must not be blocked by bookkeeping.
    }
  });

  pi.on("before_agent_start", (event: any) => {
    // One stable section keeps the provider prompt cache intact and survives compaction.
    if (state?.instructions) event.systemPromptOptions.sections[SECTION] = state.instructions;
  });

  const previousReply = async (ctx: any) => {
    if (!state) { notify(ctx, "Harness subagents are unavailable in this session; no reply was sent.", "error"); return; }
    const message = assistants(ctx).filter((item: any) => !FAILED_STOPS.has(item.stopReason))
      .map(assistantText).filter((text: string) => text.trim()).at(-1);
    if (!message) { notify(ctx, "Error: There is no previous assistant message to send to the parent.", "error"); return; }
    try {
      notify(ctx, (await call("previous_reply", ctx, { message })).notice);
    } catch (error) {
      notify(ctx, `Error: ${errorText(error)}`, "error");
    }
  };
  pi.registerCommand(PREVIOUS, {
    description: "Send this session's previous assistant message to its parent without a model call",
    handler: async (_args: string, ctx: any) => previousReply(ctx),
  });

  pi.on("input", async (event: any, ctx: any) => {
    if (!state) return;
    if (PREVIOUS_INVOCATION.test(event.text)) {
      await previousReply(ctx);
      return { action: "handled" };
    }
    const invoked = event.text.includes("/skill:");
    // Interactive children always report new turns so an unanswered armed reply expires.
    if (!invoked && state.delegatedMode !== "interactive") return;
    try {
      const result = await call("prompt", ctx, { text: event.text });
      if (result.notice) notify(ctx, result.notice);
      // A space keeps a bare /skill:name readable by Pi's command parser.
      if (result.context) return { action: "transform", text: `${event.text.trimEnd()} \n\n${result.context}`, images: event.images };
    } catch (error) {
      notify(ctx, `Harness subagents: ${errorText(error)}`, "error");
      if (invoked) return { action: "handled" };
    }
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!state?.inbox || event.isError || !WRITE_TOOLS.has(event.toolName)) return;
    const path = requestPath(event.input?.path, ctx.cwd);
    if (!path || !samePath(dirname(path), state.inbox)) return;
    let text: string;
    try {
      const result = await call("inbox_write", ctx, { paths: [path] }, 120_000);
      watch();
      if (!result.context) return;
      text = result.context;
    } catch (error) {
      text = `Harness subagents could not process ${path}: ${errorText(error)}`;
    }
    return {
      content: [...event.content, { type: "text", text }],
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
    };
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    try { await acknowledge(ctx); } catch { /* Retried by the watcher or the next start. */ }
  });

  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    if (!state || live(ctx) || event.outcome !== "completed") return;
    const deadline = Date.now() + state.stopWaitMs;
    const signal = controller.signal;
    try {
      await acknowledge(ctx);
      while (!signal.aborted) {
        const result = await call("claim_delivery", ctx);
        if (result.delivery) {
          inFlight = result.delivery.id;
          if (await acknowledge(ctx)) continue;
          return {
            entries: [{ type: "custom_message", customType: RESULT, content: result.delivery.text, display: true, details: { deliveryId: result.delivery.id } }],
            continue: true,
          };
        }
        if (!result.pending || Date.now() >= deadline) return;
        await waitForResult(ctx);
      }
    } catch (error) {
      if (!signal.aborted) notify(ctx, `Harness subagents stopped waiting for child results: ${errorText(error)}`, "warning");
    }
  });

  pi.on("agent_settled", async (event: any, ctx: any) => {
    if (!state) return;
    try {
      await acknowledge(ctx);
      if (state.delegatedMode === "interactive") {
        const last = assistants(ctx).at(-1);
        const message = assistantText(last);
        const success = !event.aborted && last !== undefined && !FAILED_STOPS.has(last.stopReason) && message.trim() !== "";
        const reason = event.aborted ? "Pi turn was aborted" : last?.stopReason === "error" ? `Pi response failed: ${last.errorMessage ?? "unknown error"}` : "Pi turn did not finish with a response";
        const result = await call("settled", ctx, { success, message, reason });
        if (result.notice) notify(ctx, result.notice);
      }
      if (inFlight) watch();
    } catch (error) {
      if (!controller.signal.aborted) notify(ctx, `Harness subagents could not record this turn: ${errorText(error)}`, "warning");
    }
  });
}
