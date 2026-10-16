import { basename } from "node:path";
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// Keep filesystem/model names on one line, without terminal control sequences.
function plain(value: string): string {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "");
}

function color(code: number, text: string): string {
  return `\x1b[${code}m${text}\x1b[39m`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const project = plain(basename(ctx.cwd) || ctx.cwd);
          const branch = footerData.getGitBranch();
          const branchLabel = branch ? `(${plain(branch)})` : "";
          const location = project + (branch
            ? ` ${branch === "main" ? color(31, branchLabel) : theme.fg("accent", branchLabel)}` : "");
          const provider = plain(ctx.model?.provider ?? "no-provider");
          const model = plain(ctx.model?.id ?? "no-model");
          const thinking = pi.getThinkingLevel();
          const usage = ctx.getContextUsage();
          const percent = usage?.percent;
          const known = typeof percent === "number" && Number.isFinite(percent);
          const context = known ? Math.round(percent).toString() : "?";
          // Resolve merged settings and model overrides through Pi's own defaults/validation.
          const compaction = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
          const window = usage?.contextWindow ?? ctx.model?.contextWindow;
          const threshold = typeof window === "number" && Number.isFinite(window) && window > 0
            ? Math.max(0, 100 * (window - compaction.reserveTokens) / window) : undefined;
          const limit = !compaction.enabled ? "off"
            : threshold === undefined ? "?" : Math.round(threshold).toString();
          const label = `${context}/${limit}%`;
          // Warn relative to the usable window, not only when the full window is nearly exhausted.
          const pressure = known ? percent / (compaction.enabled ? threshold ?? 100 : 100) : undefined;
          const colored = pressure === undefined ? label
            : color(pressure < 0.5 ? 32 : pressure < 0.75 ? 34 : pressure < 0.9 ? 33 : 31, label);
          return [truncateToWidth(`${location}  ${provider} ${model} ${thinking}  ${colored}`, Math.max(0, width))];
        },
      };
    });
  });
}
