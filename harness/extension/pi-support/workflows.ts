import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "./bridge.ts";

const hooksRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Prepare the actual input, before Pi expands /skill:name. No queued context to leak across branches. */
export function registerIssueWorkflow(pi: any, packageName: string, skills: string[], publish = false): void {
  let controller = new AbortController();
  const reset = () => { controller.abort(); controller = new AbortController(); };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => controller.abort());
  const request = async (operation: string, skill: string, argument: string, ctx: any) => {
    const result = await requestPython({
      version: 1, operation, skill, argument, cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
    }, controller.signal, join(hooksRoot, `${packageName.replaceAll("-", "_")}_pi.py`), 120_000);
    if (typeof result.ok !== "boolean" || typeof result.message !== "string") throw new Error("Pi workflow protocol mismatch");
    return result;
  };
  const display = (text: string) => pi.sendMessage({ customType: `harness-${packageName}`, content: text, display: true }, { triggerTurn: false });
  const publishIssues = async (argument: string, ctx: any) => {
    if (!ctx.isIdle()) { display("Wait for the active turn to finish before publishing issues."); return; }
    const signal = controller.signal;
    try {
      const result = await request("publish", "publish-issues", argument, ctx);
      if (!signal.aborted) display(result.message);
    } catch {
      if (!signal.aborted) display("Harness issue publishing failed. Check the Python runtime and GitHub access before retrying.");
    }
  };
  if (publish) pi.registerCommand("publish-issues", {
    description: "Publish this Pi session's reviewed issue drafts (--dry previews without mutations)",
    handler: publishIssues,
  });
  pi.on("input", async (event: any, ctx: any) => {
    const signal = controller.signal;
    const match = /^\/(?:skill:)?([a-z-]+)(?:\s+([\s\S]*))?$/.exec(event.text.trim());
    if (publish && match?.[1] === "publish-issues") {
      await publishIssues(match[2] ?? "", ctx);
      return { action: "handled" };
    }
    if (!match || !skills.includes(match[1])) {
      if (publish) {
        try {
          const result = await request("notice", "", "", ctx);
          if (signal.aborted) return { action: "handled" };
          if (result.ok && result.message) pi.sendMessage({
            customType: "harness-issue-notice", content: result.message, display: false,
          }, { triggerTurn: false });
        } catch {
          if (signal.aborted) return { action: "handled" };
          // Pending notices must not block unrelated work.
        }
      }
      return;
    }
    // A queued workflow could use repository state from before another turn's edits.
    if (!ctx.isIdle()) { display("Wait for the active turn to finish before starting an issue workflow."); return { action: "handled" }; }
    if (!pi.getCommands().some((command: any) => command.source === "skill" && command.name === `skill:${match[1]}`)) {
      display(`The ${match[1]} skill is unavailable. Reinstall the package and reload Pi before retrying.`);
      return { action: "handled" };
    }
    try {
      const result = await request("prepare", match[1], match[2] ?? "", ctx);
      if (signal.aborted) return { action: "handled" };
      if (!result.ok) { display(result.message); return { action: "handled" }; }
      return { action: "transform", text: `/skill:${match[1]} ${match[2] ?? ""}\n\n${result.message}`, images: event.images };
    } catch {
      if (!signal.aborted) display("Harness issue context preparation failed. Check the extension, Python runtime and GitHub access before retrying.");
      return { action: "handled" };
    }
  });
}
