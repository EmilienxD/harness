import type { AgentSession, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { colorizeReport, toolLabel, toolReport } from "./report.ts";
import { installStartupTools, startupSection } from "./startup.ts";

const reportType = "harness-tool-inspector:report";

export default function toolInspector(pi: ExtensionAPI) {
  let session: AgentSession | undefined;
  let theme: Theme | undefined;
  const dispose = installStartupTools(
    (current) => { session = current; },
    (current, expanded) => startupSection((showDetails) => {
      const active = new Set(current.getActiveToolNames());
      const tools = current.getAllTools().sort((a, b) => a.name.localeCompare(b.name));
      const heading = theme?.fg("mdHeading", "[Tools]") ?? "[Tools]";
      const body = tools.length ? tools.map((tool) => showDetails
        ? `  ${toolLabel(tool, active)} — ${tool.description.replace(/\s+/g, " ").trim()}`
        : toolLabel(tool, active)).join(showDetails ? "\n" : ", ") : "none";
      const indented = showDetails ? body : `  ${body}`;
      return `${heading}\n${theme?.fg("dim", indented) ?? indented}`;
    }, expanded),
  );

  pi.on("session_start", async (_event, ctx) => {
    theme = ctx.ui.theme;
    if (ctx.hasUI && !dispose) {
      ctx.ui.notify("Tool inspector: startup listing is unavailable on this Pi version; /tools still works.", "warning");
    }
  });
  pi.on("session_shutdown", async () => { dispose?.(); });

  // Custom entries render in the transcript but are excluded from model context.
  pi.registerEntryRenderer<{ text: string }>(reportType, (entry, _options, currentTheme) => ({
    render: (width) => new Text(colorizeReport(entry.data.text, currentTheme), 1, 1).render(width),
    invalidate() {},
  }));
  pi.registerCommand("tools", {
    description: "Print installed tools, descriptions, parameter schemas and output contracts; /tools <name> filters",
    getArgumentCompletions: (prefix) => pi.getAllTools()
      .filter((tool) => tool.name.startsWith(prefix))
      .map((tool) => ({ value: tool.name, label: tool.name, description: tool.description })),
    handler: async (args, ctx) => {
      const name = args.trim();
      const tools = pi.getAllTools().filter((tool) => !name || tool.name === name)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (name && !tools.length) {
        ctx.ui.notify(`Unknown tool: ${name}. Use /tools to list all tools.`, "warning");
        return;
      }
      const report = toolReport(tools, new Set(pi.getActiveTools()),
        (toolName) => session?.getToolDefinition(toolName)?.outputSchema);
      pi.appendEntry(reportType, { text: report });
    },
  });
}
