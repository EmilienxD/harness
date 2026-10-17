import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "../../harness/pi-transport/transport.ts";

const RECEIPT = "harness-commit-v1";
const helper = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "harness", "commit_pi.py");
const mutations = new Set(["write", "edit", "bash", "powershell"]);
const shells = new Set(["bash", "powershell"]);

// Pi 1.2's native write/edit resolveToCwd semantics (utils/paths.ts). Native
// definitions resolve both tools identically; canonical links are refused by
// Python rather than accidentally attributing their destination.
function nativePath(input: string, cwd: string): string {
  let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32") value = value.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
    (_match, drive, suffix) => `${drive.toUpperCase()}:\\${(suffix ?? "").replaceAll("/", "\\")}`);
  if (value === "~") value = homedir();
  else if (/^~\//.test(value) || process.platform === "win32" && /^~\\/.test(value)) value = join(homedir(), value.slice(2));
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return resolve(cwd, value);
}

export default function (pi: any) {
  let controller = new AbortController();
  let unavailable = false;
  const pending = new Map<string, any>();
  const branch = (ctx: any) => ctx.sessionManager.getBranch();
  const receipts = (ctx: any) => branch(ctx).filter((e: any) => e.type === "custom" && e.customType === RECEIPT &&
    e.data.sessionId === ctx.sessionManager.getSessionId()).flatMap((e: any) => e.data.receipts ?? []);
  const append = (ctx: any, records: any[], event?: any) => {
    if (records.length) pi.appendEntry(RECEIPT, { sessionId: ctx.sessionManager.getSessionId(),
      callId: event?.toolCallId, parentCallId: event?.parentToolCallId, receipts: records });
  };
  const reset = () => { controller.abort(); controller = new AbortController(); pending.clear(); unavailable = false; };
  pi.on("session_start", reset);
  pi.on("session_tree", (_event: any, ctx: any) => {
    reset();
    // Persist the selected leaf even when navigation creates no model message.
    append(ctx, [{ kind: "branch" }]);
  });
  pi.on("session_shutdown", () => controller.abort());

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!mutations.has(event.toolName)) return;
    const lifecycle = controller.signal;
    const state: any = { tool: event.toolName, shell: shells.has(event.toolName), command: event.input.command, overlap: false,
      expectedDigest: event.toolName === "write" && typeof event.input.content === "string" ? createHash("sha256").update(event.input.content, "utf8").digest("hex") : undefined };
    try {
      if (!state.shell) state.path = nativePath(event.input.path, ctx.cwd);
      const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
      for (const other of pending.values()) if (state.shell || other.shell || key(state.path) === key(other.path)) {
        state.overlap = true; other.overlap = true;
      }
      // Reserve before awaiting the snapshot: nested/concurrent events may run.
      pending.set(event.toolCallId, state);
      const result = await requestPython({ version: 1, operation: "snapshot", cwd: ctx.cwd,
        tool: state.tool, path: state.path, command: state.command }, lifecycle, helper);
      if (result.error) throw new Error("Commit snapshot failed");
      state.before = result.snapshot;
    } catch {
      if (!lifecycle.aborted) { unavailable = true; append(ctx, [{ kind: "uncertain", reason: "Tool attribution helper unavailable" }], event); }
    }
  });
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!mutations.has(event.toolName)) return;
    const lifecycle = controller.signal;
    const state = pending.get(event.toolCallId);
    try {
      if (!state) throw new Error("No snapshot");
      if (!state.shell && nativePath(event.input.path, ctx.cwd) !== state.path) state.overlap = true;
      const result = await requestPython({ version: 1, operation: "observe", cwd: ctx.cwd,
        tool: state.tool, path: state.path, command: state.command, before: state.before, overlap: state.overlap,
        expectedDigest: state.expectedDigest, isError: event.isError, receipts: receipts(ctx) }, lifecycle, helper);
      if (result.error || !Array.isArray(result.receipts)) throw new Error("Commit observation failed");
      if (!lifecycle.aborted) append(ctx, result.receipts, event);
    } catch {
      if (!lifecycle.aborted) { unavailable = true; append(ctx, [{ kind: "uncertain", reason: "Tool attribution incomplete" }], event); }
    } finally { pending.delete(event.toolCallId); }
  });
  // Denials bypass tool_result. Native execution-end still carries their ID.
  pi.on("tool_execution_end", (event: any) => pending.delete(event.toolCallId));

  const commit = async (args: string, ctx: any) => {
    const display = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else pi.sendMessage({ customType: "harness-commit-report", content: message, display: true }, { triggerTurn: false });
    };
    if (!ctx.isIdle() || pending.size) { display("Wait for all active tools to finish before committing."); return; }
    if (unavailable) { display("Commit stopped: tool attribution was unavailable. Review and commit the changes manually."); return; }
    const lifecycle = controller.signal;
    try {
      const leadingFlags: string[] = [];
      for (const token of args.trim().split(/\s+/)) { if (!["--dry", "-n", "--ai"].includes(token)) break; leadingFlags.push(token); }
      const messages = leadingFlags.includes("--ai") ? branch(ctx).filter((e: any) => e.type === "message" && ["user", "assistant"].includes(e.message?.role)) : [];
      const firstRequest = messages.find((e: any) => e.message.role === "user");
      const recent = messages.slice(-63);
      const selected = firstRequest && !recent.includes(firstRequest) ? [firstRequest, ...recent] : recent;
      const context = selected
        .map((e: any) => ({ role: e.message.role, text: typeof e.message.content === "string" ? e.message.content :
          (e.message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") }))
        .map((entry: any) => ({ ...entry, text: entry.text.slice(0, entry.role === "user" ? 900 : 260) }));
      const result = await requestPython({ version: 1, operation: "commit", cwd: ctx.cwd, args,
        sessionId: ctx.sessionManager.getSessionId(), receipts: receipts(ctx), context }, lifecycle, helper, 60_000);
      if (!lifecycle.aborted) { append(ctx, result.receipts ?? []); display(result.message); }
    } catch {
      if (!lifecycle.aborted) display("Harness Pi commit failed safely. Check Git and the Python runtime before retrying.");
    }
  };
  pi.registerCommand("commit", { description: "Commit verified writes on the active session branch without a model turn", handler: commit });
  pi.on("input", async (event: any, ctx: any) => {
    const match = /^\s*\/skill:commit(?:\s+([\s\S]*))?\s*$/.exec(event.text);
    if (!match) return;
    await commit(match[1] ?? "", ctx);
    return { action: "handled" };
  });
}
