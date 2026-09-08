
export type WriteCapability = "write-capable" | "read-only";

/**
 * Tools that cannot mutate the workspace. Every other name is write-capable,
 * so a tool set aboard does not recognize can never silently lose its lease.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LSP",
  "Agent",
  "WebSearch",
  "WebFetch",
]);

/** Shells that can write anything unless the rule narrows them to a command. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

/** Rules for the aboard MCP, whose tools orchestrate rather than edit files. */
const ABOARD_MCP_PREFIX = "mcp__aboard__";

export interface ToolRule {
  readonly name: string;
  /** The `(...)` argument of a `Tool(specifier)` rule, absent for a bare tool name. */
  readonly specifier?: string;
}

export type AgentDefinitionToolsResult =
  | { readonly ok: true; readonly tools: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function parseAgentDefinitionTools(
  definition: unknown,
): AgentDefinitionToolsResult {
  if (typeof definition !== "string") {
    return { ok: false, reason: "Agent definition must be text" };
  }
  const lines = definition.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { ok: false, reason: "Agent definition has no frontmatter" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    return { ok: false, reason: "Agent frontmatter is not terminated" };
  }

  const frontmatter = lines.slice(1, end);
  const toolsIndex = frontmatter.findIndex((line) => /^tools\s*:/.test(line));
  if (toolsIndex === -1) {
    return { ok: false, reason: "Agent frontmatter has no tools field" };
  }
  const toolsLine = frontmatter[toolsIndex]!;
  if (/^\s/.test(toolsLine)) {
    return { ok: false, reason: "The tools field must be top-level" };
  }
  const scalar = toolsLine.slice(toolsLine.indexOf(":") + 1).trim();
  if (scalar.length > 0) {
    if (scalar.startsWith("[") || scalar.startsWith("{") || scalar.includes("#")) {
      return { ok: false, reason: "Unsupported tools field syntax" };
    }
    const tools = splitToolRules(scalar);
    return tools === undefined
      ? { ok: false, reason: "The tools field contains malformed rules" }
      : { ok: true, tools };
  }

  const tools: string[] = [];
  for (let index = toolsIndex + 1; index < frontmatter.length; index += 1) {
    const line = frontmatter[index]!;
    if (line.trim().length === 0) continue;
    const match = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (match === null) break;
    const tool = match[1]!;
    if (tool.includes("#")) {
      return { ok: false, reason: "Unsupported tools field syntax" };
    }
    tools.push(tool);
  }
  return tools.length > 0
    ? { ok: true, tools }
    : { ok: false, reason: "The tools field is empty" };
}

function splitToolRules(value: string): readonly string[] | undefined {
  const rules: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth < 0) return undefined;
    }
    if (character === "," && depth === 0) {
      const rule = value.slice(start, index).trim();
      if (rule.length === 0) return undefined;
      rules.push(rule);
      start = index + 1;
    }
  }
  const finalRule = value.slice(start).trim();
  if (depth !== 0 || finalRule.length === 0) return undefined;
  rules.push(finalRule);
  return rules;
}

export function deriveAgentDefinitionWriteCapability(definition: unknown): WriteCapability {
  const parsed = parseAgentDefinitionTools(definition);
  return deriveWriteCapability(parsed.ok ? parsed.tools : undefined);
}

export function parseToolRule(rule: string): ToolRule | undefined {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return undefined;

  const open = trimmed.indexOf("(");
  if (open === -1) return { name: trimmed };
  if (!trimmed.endsWith(")")) return undefined;

  const name = trimmed.slice(0, open).trim();
  if (name.length === 0) return undefined;
  return { name, specifier: trimmed.slice(open + 1, -1).trim() };
}

function isUnrestricted(specifier: string | undefined): boolean {
  return specifier === undefined || specifier.length === 0 || specifier === "*";
}

export function deriveWriteCapability(
  tools: readonly string[] | undefined,
): WriteCapability {
  if (tools === undefined) return "write-capable";

  for (const rule of tools) {
    const parsed = parseToolRule(rule);
    if (parsed === undefined) return "write-capable";
    if (parsed.name === "*") return "write-capable";
    if (SHELL_TOOLS.has(parsed.name)) {
      if (isUnrestricted(parsed.specifier)) return "write-capable";
      continue;
    }
    if (READ_ONLY_TOOLS.has(parsed.name)) continue;
    if (parsed.name.startsWith(ABOARD_MCP_PREFIX)) continue;
    return "write-capable";
  }
  return "read-only";
}
