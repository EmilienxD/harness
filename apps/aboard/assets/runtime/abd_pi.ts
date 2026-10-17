import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Guard { allowedTools: string[]; denyCommands: string[]; denySubagents: boolean; readOnly: boolean; }
async function guard(): Promise<Guard | undefined> {
  const path = process.env.ABOARD_GUARD_PATH;
  if (!path) return undefined;
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || !Array.isArray(value.allowedTools) || !value.allowedTools.every((v: unknown) => typeof v === "string") || !Array.isArray(value.denyCommands) || !value.denyCommands.every((v: unknown) => typeof v === "string") || typeof value.readOnly !== "boolean" || typeof value.denySubagents !== "boolean") throw new Error("Aboard worker guard is unreadable");
  return value;
}
function python(script: string, payload: unknown, route = "worker-guard"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--no-project", "--no-managed-python", script, route], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Aboard guard timed out")); }, 10_000);
    child.stdout.on("data", (data: Buffer) => { size += data.length; if (size > 65_536) { child.kill(); reject(new Error("Aboard guard output exceeded its bound")); } else output += data.toString(); });
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error("Aboard guard failed")); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}
export default function aboard(pi: ExtensionAPI): void {
  let ready = false;
  let lastAssistant: any;
  let latestSession = "";
  let managed = true;
  const base = (ctx: ExtensionContext) => ({ agentId: process.env.ABOARD_AGENT_ID, sessionId: ctx.sessionManager.getSessionId() });
  const post = async (route: string, ctx: ExtensionContext, extra: Record<string, unknown> = {}): Promise<any> => {
    const port = process.env.ABOARD_BRIDGE_PORT;
    const token = process.env.ABOARD_BRIDGE_TOKEN;
    if (!port || !/^\d+$/u.test(port) || !token) throw new Error("Aboard bridge identity is missing");
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...base(ctx), ...extra }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Aboard lifecycle request failed (${response.status})`);
    return response.json();
  };
  pi.on("session_start", async (_event, ctx) => {
    ready = false;
    lastAssistant = undefined;
    latestSession = ctx.sessionManager.getSessionId();
    try {
      const rules = await guard();
      if (latestSession !== process.env.ABOARD_SESSION_ID) {
        if (rules) throw new Error("Aboard restricted Pi identity changed");
        managed = false; ready = true; return;
      }
      if (rules) {
        pi.setActiveTools(rules.allowedTools);
        const probe = await python(join(dirname(process.env.ABOARD_PI_EXTENSION!), "scripts", "abd_hook.py"), { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} });
        if (probe.trim()) throw new Error("Aboard guard did not confirm readiness");
      }
      ready = true;
      if (process.env.HARNESS_EXECUTION_ID) await python(join(dirname(process.env.ABOARD_PI_EXTENSION!), "scripts", "abd_hook.py"), { operation: "start", sessionId: latestSession, cwd: ctx.cwd, pid: process.pid }, "pi-runtime");
      const result = await post("/hooks/session-start", ctx);
      if (result.accepted !== true) throw new Error("Aboard rejected Pi startup");
    } catch { ready = false; process.exitCode = 1; process.exit(1); }
  });
  pi.on("session_before_switch", async () => process.env.ABOARD_GUARD_PATH ? { cancel: true } : undefined);
  pi.on("session_before_fork", async () => process.env.ABOARD_GUARD_PATH ? { cancel: true } : undefined);
  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!ready || latestSession !== ctx.sessionManager.getSessionId()) throw new Error("Aboard Pi startup has not been confirmed");
      const rules = await guard();
      if (!rules) return;
      if (rules.readOnly && !["read", "grep", "find", "ls"].includes(event.toolName)) return { block: true, reason: "Aboard exploration permits only native read tools" };
      if (!rules.allowedTools.includes(event.toolName)) return { block: true, reason: "Aboard does not permit this tool in a restricted session" };
      if (event.toolName === "bash" || event.toolName === "powershell") {
        const output = await python(join(dirname(process.env.ABOARD_PI_EXTENSION!), "scripts", "abd_hook.py"), { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: event.input });
        if (output.trim()) {
          const decision = JSON.parse(output)?.hookSpecificOutput;
          if (decision?.permissionDecision === "deny") return { block: true, reason: decision.permissionDecisionReason };
          throw new Error("Aboard guard returned an invalid decision");
        }
      }
    } catch { return { block: true, reason: "Aboard guard is unavailable; this tool call is blocked" }; }
  });
  pi.on("input", async (_event, ctx) => { lastAssistant = undefined; });
  // This boundary runs only for accepted agent turns, after native command dispatch.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!managed) return;
    if (!ready) { process.exitCode = 1; process.exit(1); }
    await post("/hooks/prompt-submit", ctx);
    const guidance = process.env.ABOARD_WORKTREE_GUIDANCE;
    if (guidance) return { message: { customType: "aboard-worktree", content: guidance, display: false } };
  });
  pi.on("message_end", (event) => { if (event.message.role === "assistant") lastAssistant = event.message; });
  pi.on("agent_settled", async (event, ctx) => {
    if (!managed) return;
    const message = lastAssistant;
    const text = message?.content?.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n") ?? "";
    const success = !event.aborted && message?.stopReason === "stop" && text.trim().length > 0;
    if (process.env.HARNESS_EXECUTION_ID) await python(join(dirname(process.env.ABOARD_PI_EXTENSION!), "scripts", "abd_hook.py"), { operation: "settled", sessionId: ctx.sessionManager.getSessionId(), message: text, success, reason: success ? undefined : message?.errorMessage ?? "Pi did not finish successfully" }, "pi-runtime");
    await post(success ? "/hooks/stop" : "/hooks/stop-failure", ctx, success ? { cwd: ctx.cwd, lastAssistantMessage: text } : { error: message?.errorMessage ?? "Pi turn ended without a successful final answer", aborted: event.aborted });
  });
  pi.on("session_compact", async (event, ctx) => {
    if (!managed) return;
    if (!["address", "review"].includes(process.env.ABOARD_AGENT_TYPE ?? "")) return;
    await post("/hooks/worker/post-compact", ctx, { summary: event.compactionEntry.summary });
    const result = await post("/hooks/worker/reground", ctx);
    if (typeof result.additionalContext === "string") pi.sendMessage({ customType: "aboard-reground", content: result.additionalContext, display: false });
  });
  pi.on("session_shutdown", async (event, ctx) => {
    ready = false;
    if (!managed) return;
    await post("/hooks/session-end", ctx, { reason: event.reason }).catch(() => undefined);
  });
}
