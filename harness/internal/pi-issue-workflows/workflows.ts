import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPython } from "../pi-transport/transport.ts";

const supportRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
    }, controller.signal, join(supportRoot, `${packageName.replaceAll("-", "_")}_pi.py`), 120_000);
    if (typeof result.ok !== "boolean" || typeof result.message !== "string") throw new Error("Pi workflow protocol mismatch");
    return result;
  };
  const display = (text: string) => pi.sendMessage({ customType: `harness-${packageName}`, content: text, display: true }, { triggerTurn: false });
  // Keep the human report in the transcript; the next input receives the compact notice.
  if (publish) pi.on("context", (event: any) => ({
    messages: event.messages.filter((message: any) => message.customType !== `harness-${packageName}`),
  }));
  const failure = (error: unknown, publishing: boolean): string => {
    const message = error instanceof Error ? error.message : "";
    const stage = publishing ? "Issue publishing" : "Issue context preparation";
    if (message === "Pi helper timeout") return publishing
      ? "Issue publishing timed out; some issues may have been created. Rerun /publish-issues to recover."
      : `${stage} timed out. Retry when the repository is ready.`;
    if (message.includes("limit")) return `${stage} exceeded the helper size limit. Reduce the batch or context before retrying.`;
    if (message.includes("require uv or Python")) return `${stage} needs uv or Python 3.11+. Install it and retry.`;
    if (message.includes("protocol") || error instanceof SyntaxError) return `${stage} received an invalid helper response. Reinstall the package and reload Pi.`;
    return `${stage} failed. Check the installed Python helper and runtime, then retry.`;
  };
  const publishIssues = async (argument: string, ctx: any) => {
    if (!ctx.isIdle()) { display("Wait for the active turn to finish before publishing issues."); return; }
    const signal = controller.signal;
    ctx.ui.notify(argument.trim() === "--dry" ? "Previewing issue drafts…" : "Publishing issue drafts…", "info");
    try {
      const result = await request("publish", "publish-issues", argument, ctx);
      if (!signal.aborted) display(result.message);
    } catch (error) {
      if (!signal.aborted) display(failure(error, true));
    }
  };
  if (publish) pi.registerCommand("publish-issues", {
    description: "Publish this Pi session's reviewed issue drafts (--dry previews without mutations)",
    handler: publishIssues,
  });
  pi.on("input", async (event: any, ctx: any) => {
    const signal = controller.signal;
    const pattern = publish ? /^\/skill:([a-z-]+)(?:\s+([\s\S]*))?$/ : /^\/(?:skill:)?([a-z-]+)(?:\s+([\s\S]*))?$/;
    const match = pattern.exec(event.text.trim());
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
      if (publish && match[1] !== "to-spec") ctx.ui.notify("Preparing issue drafts…", "info");
      const result = await request("prepare", match[1], match[2] ?? "", ctx);
      if (signal.aborted) return { action: "handled" };
      if (!result.ok) { display(result.message); return { action: "handled" }; }
      return { action: "transform", text: `/skill:${match[1]} ${match[2] ?? ""}\n\n${result.message}`, images: event.images };
    } catch (error) {
      if (!signal.aborted) display(failure(error, false));
      return { action: "handled" };
    }
  });
}
