// Pi Calm - gapless built-in tool-shell presentation adapter.
//
// Adapted from the Firstmate project's Calm implementation.
// Copyright (c) 2026 Kun Chen. MIT License - see the package's LICENSE.
//
// Pi 1.2.0 spreads definitions in withBuiltInRenderers(), preserving execute
// but not object identity.
// Track executors as well so those presentation copies retain built-in ownership.
//
// Verified against Pi 1.2.0, which exports AgentSession and
// ToolExecutionComponent. The source-aware lookup returns Pi's active definition
// unchanged and the adapter changes only its final TUI row layout. Execution,
// settings, SDK overrides, extension collisions, and stored results remain
// owned by Pi. Image results remain visible without their call/result shell,
// and unrelated custom tools render unchanged. Web Toolkit explicitly opts its
// search/fetch executors into the same presentation-only layout.
import {
  AgentSession,
  ToolExecutionComponent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { calmHidesTranscriptChrome, getCalmToolCall, getCalmToolSpinner, type CalmToolCall } from "./visibility.ts";

const CALM_BUILT_IN_TOOL_NAMES = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

type ToolRowPresentationState = {
  toolName: string;
  toolCallId: string;
  ui: { requestRender(): void };
  toolDefinition?: ToolDefinition;
  imageComponents: Component[];
  imageSpacers: Component[];
};

type AgentSessionPresentationState = {
  _baseToolsOverride?: Record<string, unknown>;
};

type CalmBuiltInToolShellPatch = {
  hidesShell: () => boolean;
  builtInDefinitions: WeakSet<ToolDefinition>;
  builtInExecutors: WeakSet<ToolDefinition["execute"]>;
  latestCall: () => CalmToolCall | undefined;
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

  const originalGetToolDefinition = AgentSession.prototype.getToolDefinition;
  if (typeof originalGetToolDefinition !== "function") {
    throw new Error("Pi Calm requires Pi AgentSession.getToolDefinition");
  }
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
    builtInDefinitions: new WeakSet(),
    builtInExecutors: new WeakSet(),
    latestCall: getCalmToolCall,
    spinnerFrame: getCalmToolSpinner,
    originalRender,
    renderCurrent: (component, width) => originalRender.call(component, width),
  };
  patch.hidesShell = hidesShell;
  patch.latestCall = getCalmToolCall;
  patch.spinnerFrame = getCalmToolSpinner;
  if (!reusable) AgentSession.prototype.getToolDefinition = function (
    name: string,
  ): ToolDefinition | undefined {
    const definition = originalGetToolDefinition.call(this, name);
    const source = this.getAllTools().find((tool) => tool.name === name)?.sourceInfo.source;
    if (definition) {
      const session = this as unknown as AgentSessionPresentationState;
      const isSdkBaseOverride = Object.hasOwn(session._baseToolsOverride ?? {}, name);
      if (source === "builtin" && !isSdkBaseOverride) {
        patch.builtInDefinitions.add(definition);
        patch.builtInExecutors.add(definition.execute);
      } else {
        patch.builtInDefinitions.delete(definition);
        patch.builtInExecutors.delete(definition.execute);
      }
    }
    return definition;
  };

  // Reload refreshes this callback, so a live process uses the new drawing code.
  patch.renderCurrent = (component, width): string[] => {
    const state = component as unknown as ToolRowPresentationState;
    patch.requestRender = () => state.ui.requestRender();
    const isKnownBuiltIn =
      CALM_BUILT_IN_TOOL_NAMES.has(state.toolName) &&
      state.toolDefinition !== undefined &&
      (patch.builtInDefinitions.has(state.toolDefinition) ||
        patch.builtInExecutors.has(state.toolDefinition.execute));
    const isWebToolkit =
      (state.toolName === "web_search" || state.toolName === "web_fetch") &&
      (state.toolDefinition?.execute as unknown as Record<symbol, unknown> | undefined)
        ?.[Symbol.for("harness:calm:web-toolkit:v1")] === true;
    if ((!isKnownBuiltIn && !isWebToolkit) || !patch.hidesShell()) {
      return originalRender.call(component, width);
    }

    const lines: string[] = [];
    const call = patch.latestCall();
    if (call?.rowId === state.toolCallId && width > 0) {
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
