/**
 * Write-capability derivation (spec section 8.1).
 *
 * Capability is *derived* from the effective tool set, never declared. The
 * derivation is only sound because `--agent` and `--tools` are mutually
 * exclusive (spec section 5.1.1): nothing at launch can widen an agent past
 * what its definition declares. Unknown capability always resolves to the
 * restrictive answer, which is write-capable.
 */

export type WriteCapability = "write-capable" | "read-only";

/** Tools that edit workspace files directly. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit"]);

/** Shells that can write anything unless the rule narrows them to a command. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

export interface ToolRule {
  readonly name: string;
  /** The `(...)` argument of a `Tool(specifier)` rule, absent for a bare tool name. */
  readonly specifier?: string;
}

export type AgentDefinitionToolsResult =
  | { readonly ok: true; readonly tools: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the load-bearing `tools` field from an agent definition boundary.
 * Claude documents it as a comma-separated scalar; a YAML sequence is also
 * accepted so scaffold formatting can evolve without changing domain policy.
 */
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

/**
 * Parses one `ToolName` or `ToolName(specifier)` rule. Returns `undefined` for
 * a rule we cannot understand, which callers must treat as unknown capability
 * rather than as an absent capability.
 */
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

/**
 * Derives capability from an effective tool set.
 *
 * `undefined` means there is no tool set to read — a raw agent (spec section
 * 5.7) or an agent definition we failed to parse — and is write-capable by the
 * conservative rule above.
 */
export function deriveWriteCapability(
  tools: readonly string[] | undefined,
): WriteCapability {
  if (tools === undefined) return "write-capable";

  for (const rule of tools) {
    const parsed = parseToolRule(rule);
    if (parsed === undefined) return "write-capable";
    if (parsed.name === "*") return "write-capable";
    if (WRITE_TOOLS.has(parsed.name)) return "write-capable";
    if (SHELL_TOOLS.has(parsed.name) && isUnrestricted(parsed.specifier)) {
      return "write-capable";
    }
  }
  return "read-only";
}
