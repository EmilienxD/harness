import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "../../hooks/pi-support/bridge.ts";

const helper = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "hooks", "no_new_documents_pi.py");

// Match Pi 1.2.0's tools/path-utils resolveToCwd and utils/paths normalizePath.
// These helpers are private; importing them would couple installs to Pi's layout.
function writePath(input: string, cwd: string): string {
  let path = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
    if (drive) path = `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
  else if (path.startsWith("file://")) path = fileURLToPath(path);
  return resolve(cwd, path);
}

export default function (pi: any) {
  let controller = new AbortController();
  const reset = () => { controller.abort(); controller = new AbortController(); };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => controller.abort());
  const request = (operation: string, ctx: any, extra = {}) => requestPython({
    version: 1, cwd: ctx.cwd, operation, ...extra,
  }, controller.signal, helper);
  const display = (message: string, outcomes = {}) => pi.sendMessage({
    customType: "harness-document-drafts", content: message, display: true, details: { outcomes },
  }, { triggerTurn: false });
  const command = async (verb: string, argument: string, ctx: any) => {
    if (!ctx.isIdle()) { display("Wait for the active turn to finish before approving or rejecting document drafts."); return; }
    const signal = controller.signal;
    try {
      const result = await request(verb, ctx, { argument });
      if (typeof result.message !== "string" || !result.outcomes) throw new Error("Invalid draft command response");
      // Native custom messages persist on this branch and reach the next model turn.
      // No process-global notice queue can deliver an abandoned branch's approval.
      if (!signal.aborted) display(result.message, result.outcomes);
    } catch {
      if (!signal.aborted) display("Harness document draft command failed. Check the Python runtime and filesystem before retrying.");
    }
  };
  for (const verb of ["approve", "reject"]) pi.registerCommand(`${verb}-doc-draft`, {
    description: verb === "approve" ? "Approve reviewed document drafts without overwriting existing files" : "Discard selected document drafts",
    handler: (argument: string, ctx: any) => command(verb, argument, ctx),
  });
  pi.on("input", async (event: any, ctx: any) => {
    const match = /^\/(?:skill:)?(approve|reject)-doc-draft(?:\s+([\s\S]*))?$/.exec(event.text.trim());
    if (!match) return;
    // Ordinary extension-origin input cannot impersonate a user command.
    // Trusted extensions opting into native command dispatch can invoke the
    // registered commands directly; Pi exposes no origin in command contexts.
    if (event.source === "extension") display("Document draft approval and rejection require a direct user command.");
    else await command(match[1], match[2] ?? "", ctx);
    return { action: "handled" };
  });
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const signal = controller.signal;
    try {
      const result = await request("pending", ctx);
      if (typeof result.message !== "string") throw new Error("Invalid pending draft response");
      if (!signal.aborted && result.message) return { message: { customType: "harness-pending-document-drafts", content: result.message, display: false } };
    } catch {
      if (!signal.aborted) display("Harness could not inspect pending document drafts. Check the Python runtime and draft directory.");
    }
  });
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!["write", "bash", "powershell"].includes(event.toolName)) return;
    try {
      // Normalize only the policy input. Mutating the actual tool input could
      // apply Pi's @ or Unicode normalization twice to a literal filename.
      const input = event.toolName === "write" ? { ...event.input, path: writePath(event.input.path, ctx.cwd) } : event.input;
      const result = await request("guard", ctx, { tool: event.toolName, input });
      if (typeof result.block !== "boolean" || typeof result.message !== "string") throw new Error("Invalid document guard response");
      if (result.block) return { block: true, reason: result.message };
    } catch {
      return { block: true, reason: "Harness document guard failed. Fix the policy or Python runtime before retrying." };
    }
  });
}
