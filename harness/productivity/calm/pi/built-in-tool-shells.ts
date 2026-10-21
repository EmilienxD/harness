// Pi Calm - gapless universal tool-shell presentation adapter.
//
// Adapted from the Firstmate project's Calm implementation.
// Copyright (c) 2026 Kun Chen. MIT License - see the package's LICENSE.
//
// Apply presentation filtering at Pi's common tool-row boundary, independent of
// tool names, sources, definitions, or custom renderers. Execution and stored
// results remain owned by Pi; image components remain visible.
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { calmHidesTranscriptChrome, getCalmToolCalls, getCalmToolSpinner, type CalmToolCall } from "./visibility.ts";

type ToolRowPresentationState = {
  toolCallId: string;
  ui: { requestRender(): void };
  imageComponents: Component[];
  imageSpacers: Component[];
};

type CalmBuiltInToolShellPatch = {
  hidesShell: () => boolean;
  calls: () => readonly CalmToolCall[];
  spinnerFrame: () => string;
  originalRender: ToolExecutionComponent["render"];
  renderCurrent: (component: ToolExecutionComponent, width: number) => string[];
  requestRender?: () => void;
};

const CALM_BUILT_IN_TOOL_SHELL_PATCH = Symbol.for(
  "pi-calm:built-in-tool-shell-layout:pi-0.82.0",
);

export function installCalmBuiltInToolShellLayout(): () => void {
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: CalmBuiltInToolShellPatch | undefined;
  };
  const hidesShell = (): boolean => calmHidesTranscriptChrome();
  const installed = registry[CALM_BUILT_IN_TOOL_SHELL_PATCH];
  const reusable = installed?.renderCurrent ? installed : undefined;

  if (typeof ToolExecutionComponent !== "function") {
    throw new Error("Pi Calm requires Pi ToolExecutionComponent");
  }
  const originalRender = reusable?.originalRender ?? ToolExecutionComponent.prototype.render;
  if (typeof originalRender !== "function") {
    throw new Error("Pi Calm requires Pi ToolExecutionComponent.render");
  }

  if (installed && !reusable) installed.hidesShell = () => false;

  const patch: CalmBuiltInToolShellPatch = reusable ?? {
    hidesShell,
    calls: getCalmToolCalls,
    spinnerFrame: getCalmToolSpinner,
    originalRender,
    renderCurrent: (component, width) => originalRender.call(component, width),
  };
  patch.hidesShell = hidesShell;
  patch.calls = getCalmToolCalls;
  patch.spinnerFrame = getCalmToolSpinner;
  // Reload refreshes this callback, so a live process uses the new drawing code.
  patch.renderCurrent = (component, width): string[] => {
    const state = component as unknown as ToolRowPresentationState;
    patch.requestRender = () => state.ui.requestRender();
    if (!patch.hidesShell()) {
      return originalRender.call(component, width);
    }

    const lines: string[] = [];
    for (const call of patch.calls()) {
      if (call.rowId !== state.toolCallId || width <= 0) continue;
      if (width < 7) {
        lines.push(...wrapTextWithAnsi(call.summary, width).map((line) => truncateToWidth(line, width)));
      }
      else {
        const edge = "─".repeat(width - 2);
        lines.push("", `╭${edge}╮`);
        const body = wrapTextWithAnsi(call.summary, width - 6);
        for (const [index, line] of body.entries()) {
          const marker = call.status === "running" ? patch.spinnerFrame()
            : `\u001b[${call.status === "success" ? 32 : 31}m•\u001b[39m`;
          const spinner = index === 0 ? marker : " ";
          lines.push(`│ ${spinner} ${truncateToWidth(line, width - 6, "", true)} │`);
        }
        lines.push(`╰${edge}╯`);
      }
    }
    for (let index = 0; index < state.imageComponents.length; index += 1) {
      const spacer = state.imageSpacers[index];
      if (spacer) lines.push(...spacer.render(width));
      const image = state.imageComponents[index];
      if (image) lines.push(...image.render(width));
    }
    return lines;
  };
  if (!reusable) ToolExecutionComponent.prototype.render = function (width: number): string[] {
    return patch.renderCurrent(this, width);
  };

  registry[CALM_BUILT_IN_TOOL_SHELL_PATCH] = patch;
  return () => patch.requestRender?.();
}
