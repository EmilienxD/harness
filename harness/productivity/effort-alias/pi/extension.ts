import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description: "Set thinking effort (alias for /thinking)",
		handler: async (args, ctx) => {
			const levels = ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off" as const];
			let level: string | undefined = args.trim().toLowerCase();
			if (!level) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Usage: /effort <${levels.join("|")}>`, "info");
					return;
				}
				level = await ctx.ui.select(`Thinking level (current: ${pi.getThinkingLevel()})`, levels);
				if (level === undefined) return;
			}
			const selected = levels.find((candidate) => candidate === level);
			if (!selected) {
				ctx.ui.notify(`Unknown thinking level "${level}". Available levels: ${levels.join(", ")}.`, "error");
				return;
			}
			pi.setThinkingLevel(selected);
			ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
		},
	});
}
