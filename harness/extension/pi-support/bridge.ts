import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RECEIPT = "harness-path-guard-v1";
const supportRoot = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;

// The same interpreter preference as Harness's installer; argv never uses a shell.
const interpreters = [
  ["uv", "run", "--offline", "--no-project", "--no-managed-python"],
  ["python3"], ["python"], ["py"],
];

export async function requestPython(request: unknown, signal: AbortSignal, script = join(supportRoot, "path_guards.py"), timeout = 10_000): Promise<any> {
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("Pi helper input limit");
  for (const argv of interpreters) {
    try {
      const response = await new Promise<string>((resolve, reject) => {
        if (signal.aborted) { reject(new Error("Pi helper cancelled")); return; }
        const child = spawn(argv[0], [...argv.slice(1), script], {
          cwd: (request as any).cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        });
        // Stop the interpreter launcher and its Git/GitHub children together.
        const stop = () => {
          if (!child.pid) return;
          if (process.platform === "win32") {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            killer.on("error", () => child.kill());
          } else {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
          }
        };
        const abort = () => { stop(); reject(new Error("Pi helper cancelled")); };
        signal.addEventListener("abort", abort, { once: true });
        let output = "";
        let bytes = 0;
        const timer = setTimeout(() => { stop(); reject(new Error("Pi helper timeout")); }, timeout);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BYTES) { stop(); reject(new Error("Pi helper output limit")); }
          else output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { stop(); reject(new Error("Pi helper output limit")); }
        });
        child.on("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (code !== 0) reject(new Error("Pi helper subprocess failed"));
          else resolve(output);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(payload);
      });
      const result = JSON.parse(response);
      if (result.version !== 1) {
        throw new Error("Pi helper protocol mismatch");
      }
      return { ...result, launchArgv: argv };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Pi guards require uv or Python 3.11+");
}

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
    if (phase === "call" && (packageName !== "on-edit-block" || !["write", "edit"].includes(event.toolName))) return;
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
      }, controller.signal);
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
