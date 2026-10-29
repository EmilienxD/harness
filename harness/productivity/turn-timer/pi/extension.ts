import { performance } from "node:perf_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Presentation only: no model requests or session entries. */
export default function (pi: ExtensionAPI) {
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let render: (() => void) | undefined;
  let restore: (() => void) | undefined;

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    startedAt = undefined;
    render = undefined;
    restore?.();
    restore = undefined;
  }

  pi.on("input", (_event, ctx) => {
    if (ctx.hasUI) {
      startedAt = performance.now();
      render?.();
    }
    return { action: "continue" };
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    startedAt ??= performance.now();
    if (timer !== undefined) clearInterval(timer);
    render = () => {
      const seconds = Math.max(0, Math.floor((performance.now() - startedAt!) / 1000));
      ctx.ui.setWorkingMessage(
        `Working · ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`,
      );
    };
    restore = () => ctx.ui.setWorkingMessage();
    render();
    timer = setInterval(() => render?.(), 1000);
    timer.unref();
  });

  // agent_end can precede automatic retries, compaction or queued work.
  pi.on("agent_settled", stop);
  pi.on("session_switch", stop);
  pi.on("session_shutdown", stop);
}
