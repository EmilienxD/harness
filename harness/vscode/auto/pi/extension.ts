import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function auto(pi: ExtensionAPI): void {
  pi.registerCommand("auto", {
    description: "Start or preview Aboard Auto Run",
    handler: async (args, ctx) => {
      const message = await new Promise<string>((resolve) => {
        const script = join(dirname(fileURLToPath(import.meta.url)), "..", "harness", "auto_hook.py");
        const child = spawn("uv", ["run", "--no-project", "--no-managed-python", script], { cwd: ctx.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = ""; let size = 0; let settled = false;
        const done = (message: string) => { if (settled) return; settled = true; clearTimeout(timer); resolve(message); };
        const timer = setTimeout(() => { child.kill(); done("Aboard /auto timed out."); }, 120_000);
        child.stdout.resume();
        child.stderr.on("data", (data: Buffer) => { size += data.length; if (size > 65_536) { child.kill(); done("Aboard /auto returned too much output."); } else stderr += data.toString(); });
        child.once("error", () => done("Aboard /auto could not start its Python runtime."));
        child.once("close", () => done(stderr.trim() || "Aboard handled /auto."));
        child.stdin.on("error", () => undefined);
        child.stdin.end(JSON.stringify({ prompt: `/auto${args ? ` ${args}` : ""}`, session_id: ctx.sessionManager.getSessionId() }));
      });
      ctx.ui.notify(message, "info");
    },
  });
}
