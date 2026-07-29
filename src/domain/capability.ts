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
