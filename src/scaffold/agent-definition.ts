import {
  deriveWriteCapability,
  parseAgentDefinitionTools,
  type WriteCapability,
} from "../domain/capability.js";

/** The Manager runs as the main session agent (`--agent manager`). */
export const MANAGER_AGENT_NAME = "manager";

export const WORKER_AGENT_NAMES = [
  "brainstormer",
  "implementer",
  "pr-doctor-afk",
  "pr-doctor-hitl",
] as const;

export const SCAFFOLDED_AGENT_NAMES = [MANAGER_AGENT_NAME, ...WORKER_AGENT_NAMES] as const;

export type WorkerAgentName = (typeof WORKER_AGENT_NAMES)[number];
export type ScaffoldedAgentName = (typeof SCAFFOLDED_AGENT_NAMES)[number];
export type AgentModel = "opus" | "sonnet" | "haiku" | "fable" | "inherit";

export interface AgentDefinition {
  readonly name: WorkerAgentName;
  readonly description: string;
  readonly model: AgentModel;
  readonly tools: readonly string[];
  readonly prompt: string;
  readonly writeCapability: WriteCapability;
}

/**
 * The Manager definition deliberately declares no `tools:`. An agent that omits
 * the field inherits the full tool pool, which is what lets the launch preset
 * (`--tools`, spec section 4.3) remain the Manager's single tool authority
 * without contradicting the file. A `tools:` line here would silently compete
 * with the setting, so it is rejected rather than merged.
 */
export interface ManagerAgentDefinition {
  readonly name: typeof MANAGER_AGENT_NAME;
  readonly description: string;
  readonly model: AgentModel;
  readonly prompt: string;
}

export type AgentDefinitionResult =
  | { readonly ok: true; readonly value: AgentDefinition }
  | { readonly ok: false; readonly reason: string };

export type ManagerAgentDefinitionResult =
  | { readonly ok: true; readonly value: ManagerAgentDefinition }
  | { readonly ok: false; readonly reason: string };

const MODELS: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku", "fable", "inherit"]);

function scalarField(lines: readonly string[], field: string): string | undefined {
  const prefix = `${field}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

interface ParsedDocument {
  readonly frontmatter: readonly string[];
  readonly prompt: string;
}

type DocumentResult =
  | { readonly ok: true; readonly value: ParsedDocument }
  | { readonly ok: false; readonly reason: string };

function splitDefinition(definition: unknown): DocumentResult {
  if (typeof definition !== "string") {
    return { ok: false, reason: "Agent definition must be text" };
  }
  const lines = definition.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { ok: false, reason: "Agent definition has no frontmatter" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { ok: false, reason: "Agent frontmatter is not terminated" };

  const prompt = lines.slice(end + 1).join("\n").trim();
  if (prompt.length === 0) return { ok: false, reason: "Agent system prompt is empty" };
  return { ok: true, value: { frontmatter: lines.slice(1, end), prompt } };
}

interface CommonFields {
  readonly description: string;
  readonly model: AgentModel;
}

type CommonFieldsResult =
  | { readonly ok: true; readonly value: CommonFields }
  | { readonly ok: false; readonly reason: string };

function commonFields(frontmatter: readonly string[]): CommonFieldsResult {
  const description = scalarField(frontmatter, "description");
  if (description === undefined) return { ok: false, reason: "Agent description is missing" };
  const model = scalarField(frontmatter, "model");
  if (model === undefined || !MODELS.has(model)) {
    return { ok: false, reason: `Unsupported agent model: ${model ?? "missing"}` };
  }
  return { ok: true, value: { description, model: model as AgentModel } };
}

/** Parses the small, security-relevant subset of Claude agent frontmatter aboard ships. */
export function parseAgentDefinition(definition: unknown): AgentDefinitionResult {
  const document = splitDefinition(definition);
  if (!document.ok) return document;

  const { frontmatter, prompt } = document.value;
  const name = scalarField(frontmatter, "name");
  if (!WORKER_AGENT_NAMES.includes(name as WorkerAgentName)) {
    return { ok: false, reason: `Unsupported aboard agent name: ${name ?? "missing"}` };
  }
  const common = commonFields(frontmatter);
  if (!common.ok) return common;
  const parsedTools = parseAgentDefinitionTools(definition);
  if (!parsedTools.ok) return parsedTools;

  return {
    ok: true,
    value: {
      name: name as WorkerAgentName,
      description: common.value.description,
      model: common.value.model,
      tools: parsedTools.tools,
      prompt,
      writeCapability: deriveWriteCapability(parsedTools.tools),
    },
  };
}

/** The Manager definition, which must leave its tool set to the launch preset. */
export function parseManagerAgentDefinition(
  definition: unknown,
): ManagerAgentDefinitionResult {
  const document = splitDefinition(definition);
  if (!document.ok) return document;

  const { frontmatter, prompt } = document.value;
  if (scalarField(frontmatter, "name") !== MANAGER_AGENT_NAME) {
    return { ok: false, reason: "The Manager definition must be named manager" };
  }
  if (frontmatter.some((line) => /^tools\s*:/.test(line))) {
    return {
      ok: false,
      reason: "The Manager definition must declare no tools; the launch preset owns its tool set",
    };
  }
  const common = commonFields(frontmatter);
  if (!common.ok) return common;

  return {
    ok: true,
    value: {
      name: MANAGER_AGENT_NAME,
      description: common.value.description,
      model: common.value.model,
      prompt,
    },
  };
}
