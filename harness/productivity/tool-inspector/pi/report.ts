import type { Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { formatSchema } from "./schema.ts";

export function toolLabel(tool: ToolInfo, active: Set<string>): string {
  if (active.has(tool.name)) return tool.name;
  if (tool.exposure === "hidden") return `${tool.name} (hidden)`;
  const callableLater = (tool.exposure === "deferred" || tool.exposure === "codemode") &&
    (active.has("tool_search") || active.has("codemode"));
  return `${tool.name} (${callableLater ? "differed" : "not active"})`;
}

/** Apply the current Pi theme at render time; persisted reports remain plain text. */
export function colorizeReport(text: string, theme: Pick<Theme, "fg" | "bold">): string {
  const inline = (line: string) => line.replace(/`([^`\n]+)`/g,
    (_match, code: string) => theme.fg("mdCode", code));
  return text.split("\n\n" + "─".repeat(48) + "\n\n").map((section) =>
    section.split("\n").map((line, index) => {
      if (index === 0) return theme.bold(theme.fg("mdHeading", line));
      if (line === "Parameters:" || line === "Output:" || line === "Structured result:") {
        return theme.bold(theme.fg("mdHeading", line));
      }
      if (line.startsWith("Exposure:") || line.startsWith("Source:") ||
          line.startsWith("No output schema") || line.startsWith("Pi tool results")) {
        return theme.fg("dim", inline(line));
      }
      const field = /^(\s*)([^:]+): (.+?)( \((?:required|optional)\))?$/.exec(line);
      if (field) {
        const [, indent, name, value, presence] = field;
        const marker = presence ? theme.fg(presence.includes("required") ? "success" : "dim", presence) : "";
        return `${indent}${theme.fg("accent", name)}: ${theme.fg("mdCode", value)}${marker}`;
      }
      return inline(line);
    }).join("\n"),
  ).join("\n\n" + theme.fg("dim", "─".repeat(48)) + "\n\n");
}

export function toolReport(
  tools: ToolInfo[],
  active: Set<string>,
  outputSchema: (name: string) => unknown,
): string {
  if (!tools.length) return "No tools are configured.";
  return tools.map((tool) => {
    const schema = outputSchema(tool.name);
    return [
      toolLabel(tool, active),
      `Exposure: ${tool.exposure}${tool.namespace ? ` | Namespace: ${tool.namespace}` : ""}`,
      `Source: ${tool.sourceInfo?.path ?? tool.sourceInfo?.source ?? "unknown"}`,
      "",
      tool.description,
      "",
      "Parameters:",
      formatSchema(tool.parameters),
      "",
      "Output:",
      schema === undefined
        ? "No output schema exposed by Pi for this tool. The result is tool-specific; no return shape is inferred."
        : `Structured result:\n${formatSchema(schema)}`,
      "Pi tool results carry content (text/image blocks), details, and optionally structuredContent; failures are marked as errors.",
    ].join("\n");
  }).join("\n\n" + "─".repeat(48) + "\n\n");
}
