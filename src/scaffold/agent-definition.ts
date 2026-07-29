import {
  deriveWriteCapability,
  parseAgentDefinitionTools,
  type WriteCapability,
} from "../domain/capability.js";

export const SCAFFOLDED_AGENT_NAMES = [
  "brainstormer",
  "implementer",
  "reviewer",
  "fixer",
] as const;

export type ScaffoldedAgentName = (typeof SCAFFOLDED_AGENT_NAMES)[number];
export type AgentModel = "opus" | "sonnet" | "haiku" | "fable" | "inherit";

export interface AgentDefinition {
  readonly name: ScaffoldedAgentName;
  readonly description: string;
  readonly model: AgentModel;
  readonly tools: readonly string[];
  readonly prompt: string;
  readonly writeCapability: WriteCapability;
}

export type AgentDefinitionResult =
  | { readonly ok: true; readonly value: AgentDefinition }
  | { readonly ok: false; readonly reason: string };

const MODELS: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku", "fable", "inherit"]);

function scalarField(lines: readonly string[], field: string): string | undefined {
  const prefix = `${field}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Parses the small, security-relevant subset of Claude agent frontmatter aboard ships. */
export function parseAgentDefinition(definition: unknown): AgentDefinitionResult {
  if (typeof definition !== "string") {
    return { ok: false, reason: "Agent definition must be text" };
  }
  const lines = definition.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { ok: false, reason: "Agent definition has no frontmatter" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { ok: false, reason: "Agent frontmatter is not terminated" };

  const frontmatter = lines.slice(1, end);
  const name = scalarField(frontmatter, "name");
  if (!SCAFFOLDED_AGENT_NAMES.includes(name as ScaffoldedAgentName)) {
    return { ok: false, reason: `Unsupported aboard agent name: ${name ?? "missing"}` };
  }
  const description = scalarField(frontmatter, "description");
  if (description === undefined) return { ok: false, reason: "Agent description is missing" };
  const model = scalarField(frontmatter, "model");
  if (model === undefined || !MODELS.has(model)) {
    return { ok: false, reason: `Unsupported agent model: ${model ?? "missing"}` };
  }
  const parsedTools = parseAgentDefinitionTools(definition);
  if (!parsedTools.ok) return parsedTools;
  const prompt = lines.slice(end + 1).join("\n").trim();
  if (prompt.length === 0) return { ok: false, reason: "Agent system prompt is empty" };

  return {
    ok: true,
    value: {
      name: name as ScaffoldedAgentName,
      description,
      model: model as AgentModel,
      tools: parsedTools.tools,
      prompt,
      writeCapability: deriveWriteCapability(parsedTools.tools),
    },
  };
}
