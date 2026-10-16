import { basename } from "node:path";
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Keep filesystem/model names on one line, without terminal control sequences.
function plain(value: string): string {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "");
}

function color(code: number, text: string): string {
  return `\x1b[${code}m${text}\x1b[39m`;
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
  return value >= 1000 ? `${Math.round(value / 1000)}k` : Math.round(value).toString();
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
          const tokens = usage?.tokens;
          const known = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0;
          // Resolve merged settings and model overrides through Pi's own defaults/validation.
          const compaction = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
          const window = usage?.contextWindow ?? ctx.model?.contextWindow;
          const total = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
          const threshold = total === undefined ? undefined : Math.max(0, total - compaction.reserveTokens);
          const limit = !compaction.enabled ? "off" : formatTokens(threshold);
          const used = formatTokens(tokens);
          // Warn relative to the usable window, not only when the full window is nearly exhausted.
          const budget = compaction.enabled ? threshold ?? total : total;
          const pressure = known && budget !== undefined ? (tokens === 0 ? 0 : tokens / budget) : undefined;
          const colored = pressure === undefined ? used
            : color(pressure < 0.5 ? 32 : pressure < 0.75 ? 34 : pressure < 0.9 ? 33 : 31, used);
          const fields = [provider, thinking, model, `${colored}/${limit}/${formatTokens(total)}`];
          const line = () => [location, [fields[0], fields[2], fields[1]].filter(Boolean).join(" "), fields[3]]
            .filter(Boolean).join("  ");
          const available = Math.max(0, width);
          // Drop whole fields in priority order before truncating the project/branch.
          for (let i = 0; i < fields.length && visibleWidth(line()) > available; i++) fields[i] = "";
          return [truncateToWidth(line(), available)];
        },
      };
    });
  });
}
