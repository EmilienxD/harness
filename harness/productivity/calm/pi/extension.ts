// Forked from kunchenguid/dotfiles, revision 9a4a6387d0dd6f4bf9b8a5a732b406916bbbf95d.
// Copyright (c) 2026 Kun Chen. MIT License - see the package's LICENSE.
// Harness retains Pi's native working indicator and supports Pi 1.2 renderer copies.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { installCalmBuiltInToolShellLayout } from "./built-in-tool-shells.ts";
import { installCalmCollapsedThinkingLayout } from "./collapsed-thinking.ts";
import { loadCalmPreference, persistCalmPreference } from "./preference.ts";
import {
  calmPresentationIsActive,
  setCalmPresentation,
  setCalmStockExportRendering,
  getCalmToolCalls,
  setCalmToolCalls,
  type CalmToolCall,
  setCalmToolSpinner,
} from "./visibility.ts";

function toolCallSummary(name: string, args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const text = (key: string) => typeof input[key] === "string" ? input[key] as string : "";
  const path = text("path") || text("file_path");
  let detail = path;
  if (name === "bash" || name === "powershell") detail = text("command");
  else if (name === "grep" || name === "find") detail = [text("pattern"), path].filter(Boolean).join(" ");
  else if (name === "web_search") detail = text("query");
  else if (name === "web_fetch") detail = text("url");
  // Show routing arguments, never write contents or edit text.
  const summary = stripTerminalSequences([name, detail].filter(Boolean).join(" "))
    .replace(/\r\n?/g, "\n").replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
  const characters = Array.from(summary);
  return characters.length > 350 ? characters.slice(0, 349).join("") + "…" : summary;
}

function installPresentationAdapter(name: string, install: () => void): void {
  try {
    install();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Pi Calm: ${name} presentation adapter unavailable, skipping. ${reason}`);
  }
}

export default function (pi: ExtensionAPI): void {
  installPresentationAdapter("collapsed-thinking", installCalmCollapsedThinkingLayout);
  let requestToolRender = () => {};
  installPresentationAdapter("built-in-tool-shells", () => {
    requestToolRender = installCalmBuiltInToolShellLayout();
  });
  let removeTerminalInputHandler: (() => void) | undefined;
  let exportResetTimer: ReturnType<typeof setTimeout> | undefined;
  let displayTimer: ReturnType<typeof setTimeout> | undefined;
  let animationTimer: ReturnType<typeof setTimeout> | undefined;
  const spinnerFrames = ["⠴", "⠦", "⠧", "⠇", "⠏", "⠋", "⠙", "⠹", "⠸", "⠼"];
  const updateAnimation = (): void => {
    clearTimeout(animationTimer);
    animationTimer = undefined;
    const animate = calmPresentationIsActive() && getCalmToolCalls().some((call) => call.status === "running");
    setCalmToolSpinner(animate ? spinnerFrames[Math.floor(performance.now() / 80) % spinnerFrames.length]! : "⠴");
    requestToolRender();
    if (animate) {
      animationTimer = setTimeout(updateAnimation, 80);
      animationTimer.unref?.();
    }
  };
  const toolRows = new Map<string, string>();
  const calls = new Map<string, CalmToolCall>();
  // Late streaming updates must not resurrect completed or expired calls.
  const completedCalls = new Set<string>();
  const updateToolDisplay = (): void => {
    clearTimeout(displayTimer);
    displayTimer = undefined;
    const now = performance.now();
    let nextExpiry = Infinity;
    for (const [id, call] of calls) {
      if (call.completedAt === undefined) continue;
      const remaining = call.completedAt + 3000 - now;
      if (remaining <= 0) calls.delete(id);
      else nextExpiry = Math.min(nextExpiry, remaining);
    }
    setCalmToolCalls([...calls.values()]);
    updateAnimation();
    if (nextExpiry !== Infinity) {
      displayTimer = setTimeout(updateToolDisplay, nextExpiry);
      displayTimer.unref?.();
    }
  };
  const showToolCall = (next: Omit<CalmToolCall, "status" | "completedAt">): void => {
    if (completedCalls.has(next.callId)) return;
    calls.set(next.callId, { ...next, status: "running" });
    updateToolDisplay();
  };
  const completeToolCall = (callId: string, isError: boolean): void => {
    completedCalls.add(callId);
    const call = calls.get(callId);
    if (!call || call.status !== "running") return;
    calls.set(callId, { ...call, status: isError ? "error" : "success", completedAt: performance.now() });
    updateToolDisplay();
  };
  const clearToolSummary = (): void => {
    toolRows.clear();
    completedCalls.clear();
    calls.clear();
    updateToolDisplay();
  };

  pi.on("session_start", (_event, ctx) => {
    clearToolSummary();
    setCalmPresentation(loadCalmPreference());
    setCalmStockExportRendering(false);
    ctx.ui.setHiddenThinkingLabel(calmPresentationIsActive() ? "" : undefined);
    removeTerminalInputHandler?.();
    removeTerminalInputHandler = ctx.ui.onTerminalInput((data) => {
      if (!getKeybindings().matches(data, "tui.input.submit")) return;
      const input = ctx.ui.getEditorText().trim();
      if (input !== "/share" && input !== "/export" && !input.startsWith("/export ")) return;

      setCalmStockExportRendering(true);
      clearTimeout(exportResetTimer);
      exportResetTimer = setTimeout(() => {
        exportResetTimer = undefined;
        setCalmStockExportRendering(false);
        requestToolRender();
      }, 0);
    });
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    for (const call of event.message.content) {
      if (call.type !== "toolCall") continue;
      toolRows.set(call.id, call.id);
      showToolCall({ rowId: call.id, callId: call.id, summary: toolCallSummary(call.name, call.arguments) });
    }
  });

  pi.on("tool_execution_start", (event) => {
    const rowId = event.parentToolCallId
      ? toolRows.get(event.parentToolCallId) ?? event.parentToolCallId
      : event.toolCallId;
    toolRows.set(event.toolCallId, rowId);
    showToolCall({ rowId, callId: event.toolCallId, summary: toolCallSummary(event.toolName, event.args) });
  });

  pi.on("tool_execution_end", (event) => {
    completeToolCall(event.toolCallId, event.isError);
  });
  pi.on("agent_settled", () => {
    // An interrupted call without a completion event must never look successful.
    for (const [id, call] of calls) if (call.status === "running") completeToolCall(id, true);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearToolSummary();
    clearTimeout(exportResetTimer);
    exportResetTimer = undefined;
    removeTerminalInputHandler?.();
    removeTerminalInputHandler = undefined;
    setCalmPresentation(false);
    setCalmStockExportRendering(false);
    ctx.ui.setHiddenThinkingLabel(undefined);
  });

  pi.registerCommand("calm", {
    description: "Toggle Calm: show each tool call in a transient chat block and hide all tool output.",
    handler: async (_args, ctx) => {
      const active = !calmPresentationIsActive();
      persistCalmPreference(active);
      setCalmPresentation(active);
      updateToolDisplay();
      ctx.ui.setHiddenThinkingLabel(active ? "" : undefined);
      requestToolRender();
      ctx.ui.notify(`calm mode: ${active ? "enabled" : "disabled"}`, "info");
    },
  });
}
