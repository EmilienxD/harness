import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "../../hooks/pi-support/bridge.ts";

const helper = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "hooks", "cleanup_git_pi.py");

/** Inventory belongs to this exact input; no pending context survives a branch/session change. */
export default function (pi: any): void {
  let controller = new AbortController();
  const reset = () => { controller.abort(); controller = new AbortController(); };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => controller.abort());
  const display = (content: string) => pi.sendMessage({ customType: "harness-cleanup-git", content, display: true }, { triggerTurn: false });
  pi.on("input", async (event: any, ctx: any) => {
    const match = /^\/(?:skill:)?cleanup-git(?:\s+([\s\S]*))?$/.exec(event.text.trim());
    if (!match) return;
    if (!ctx.isIdle()) {
      display("Wait for the active turn to finish before collecting a Git cleanup inventory.");
      return { action: "handled" };
    }
    if (!pi.getCommands().some((command: any) => command.source === "skill" && command.name === "skill:cleanup-git")) {
      display("The cleanup-git skill is unavailable. Reinstall the package and reload Pi before retrying.");
      return { action: "handled" };
    }
    const signal = controller.signal;
    try {
      const result = await requestPython({ version: 1, cwd: ctx.cwd }, signal, helper, 120_000);
      if (signal.aborted) return { action: "handled" };
      if (typeof result.ok !== "boolean" || typeof result.message !== "string") throw new Error("Pi cleanup protocol mismatch");
      if (!result.ok) { display(result.message); return { action: "handled" }; }
      return { action: "transform", text: `/skill:cleanup-git ${match[1] ?? ""}\n\n${result.message}`, images: event.images };
    } catch {
      if (!signal.aborted) display("Git cleanup inventory failed. Check the Pi extension and Python runtime before retrying; no cleanup was performed.");
      return { action: "handled" };
    }
  });
}
