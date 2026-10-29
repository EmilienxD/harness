import { performance } from "node:perf_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Presentation only: no model requests or session entries. */
export default function (pi: ExtensionAPI) {
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let render: (() => void) | undefined;
  let restore: (() => void) | undefined;

  const widgetKey = "harness-turn-timer";
  let clearWidget: (() => void) | undefined;

  function duration() {
    const seconds = Math.max(0, Math.floor((performance.now() - startedAt!) / 1000));
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    startedAt = undefined;
    render = undefined;
    restore?.();
    restore = undefined;
    clearWidget?.();
    clearWidget = undefined;
  }

  pi.on("input", (_event, ctx) => {
    if (ctx.hasUI) {
      clearWidget?.();
      startedAt = performance.now();
      render?.();
    }
    return { action: "continue" };
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    clearWidget?.();
    clearWidget = () => ctx.ui.setWidget(widgetKey, undefined);
    startedAt ??= performance.now();
    if (timer !== undefined) clearInterval(timer);
    render = () => {
      ctx.ui.setWorkingMessage(`Working · ${duration()}`);
    };
    restore = () => ctx.ui.setWorkingMessage();
    render();
    timer = setInterval(() => render?.(), 1000);
    timer.unref();
  });

  // agent_end can precede automatic retries, compaction or queued work.
  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.hasUI || startedAt === undefined) return;
    const completed = `Worked · ${duration()}`;
    stop();
    ctx.ui.setWidget(widgetKey, [ctx.ui.theme.fg("muted", completed)], { placement: "aboveEditor" });
    clearWidget = () => ctx.ui.setWidget(widgetKey, undefined);
  });
  pi.on("session_switch", stop);
  pi.on("session_shutdown", stop);
}
