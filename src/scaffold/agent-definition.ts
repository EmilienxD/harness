import { join } from "node:path";

import {
  deriveWriteCapability,
  parseAgentDefinitionTools,
  type WriteCapability,
} from "../domain/capability.js";
import {
  EFFORT_LEVELS,
  isEffortLevel,
  parseClaudeCommand,
  type EffortLevel,
} from "../claude/launch.js";

/** The Manager runs as the main session agent. */
export const MANAGER_AGENT_NAME = "manager";

/**
 * Where aboard keeps its agent definitions — deliberately *not*
 * `.claude/agents/`, which Claude Code scans from every session that runs
 * anywhere under the workspace. A definition there is a registered subagent
 * type: the user's own `claude` sees `implementer` and the pr-doctors in its
 * Agent tool and can spawn them outside the bridge and outside the write lease.
 * aboard's agents are launched, never spawned, so their definitions live
 * somewhere nothing discovers them and reach Claude Code as launch flags
 * instead.
 */
export const AGENT_DEFINITION_DIRECTORY = ".aboard/agents";

/** Claude Code's namespaced rule for every tool served by the aboard MCP. */
export const ABOARD_MCP_TOOLS = "mcp__aboard__*";

export function declaresAboardMcpTools(tools: readonly string[]): boolean {
  return tools.some((rule) => rule.trim().startsWith("mcp__aboard__"));
}

/** Absolute path of a definition, from the one directory that holds them. */
export function agentDefinitionPath(workspaceRoot: string, name: string): string {
  return join(workspaceRoot, ...AGENT_DEFINITION_DIRECTORY.split("/"), `${name}.md`);
}

export const WORKER_AGENT_NAMES = [
  "brainstormer",
  "webresearcher",
  "implementer",
  "pr-doctor-afk",
  "pr-doctor-hitl",
] as const;

export const SCAFFOLDED_AGENT_NAMES = [MANAGER_AGENT_NAME, ...WORKER_AGENT_NAMES] as const;

export type WorkerAgentName = (typeof WORKER_AGENT_NAMES)[number];
export type ScaffoldedAgentName = (typeof SCAFFOLDED_AGENT_NAMES)[number];
export type AgentModel = "opus" | "sonnet" | "haiku" | "fable" | "inherit";
/**
 * The definition's `effort:` field. Unlike `model:` it is optional, because an
 * absent field is a meaningful value rather than an omission: the agent inherits
 * the session's effort level, which is what `aboard.launch.effort` sets.
 */
export type AgentEffort = EffortLevel;

export interface AgentDefinition {
  readonly name: WorkerAgentName;
  readonly description: string;
  readonly model: AgentModel;
  readonly effort?: AgentEffort;
  /**
   * The definition's `command:`, tokenized like `aboard.launch.claudeCommand`.
   * Absent means the setting decides, so an agent that declares nothing keeps
   * launching exactly as before.
   */
  readonly command?: readonly string[];
  readonly tools: readonly string[];
  readonly prompt: string;
  readonly writeCapability: WriteCapability;
}

/**
 * The Manager definition declares its read-only allowlist like every other
 * aboard agent: the frontmatter `tools:` field is the single tool authority,
 * and nothing on the command line may compete with it (spec section 5.1.1).
 */
export interface ManagerAgentDefinition {
  readonly name: typeof MANAGER_AGENT_NAME;
  readonly description: string;
  readonly model: AgentModel;
  readonly effort?: AgentEffort;
  readonly command?: readonly string[];
  readonly tools: readonly string[];
  readonly prompt: string;
  readonly writeCapability: WriteCapability;
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
  readonly effort?: AgentEffort;
  readonly command?: readonly string[];
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
  // An absent `effort:` inherits the session level, so only a present-but-wrong
  // value is an error: Claude Code refuses the launch outright on one.
  const effort = scalarField(frontmatter, "effort");
  if (effort !== undefined && !isEffortLevel(effort)) {
    return { ok: false, reason: `Unsupported agent effort: ${effort}. Expected one of ${EFFORT_LEVELS.join(", ")}` };
  }
  // `command:` overrides `aboard.launch.claudeCommand` for this agent alone —
  // one agent behind a provider wrapper (`clauder run kiro --`) while the rest
  // of the fleet keeps the configured default. It is read here rather than at
  // launch time so a command line that cannot be built is a parse failure the
  // user sees, not a terminal running the wrong program. An absent field means
  // the setting decides.
  const rawCommand = scalarField(frontmatter, "command");
  let command: readonly string[] | undefined;
  if (rawCommand !== undefined) {
    const parsed = parseClaudeCommand(rawCommand);
    if (!parsed.ok) return { ok: false, reason: `Invalid agent command: ${parsed.reason}` };
    command = parsed.value;
  }
  return {
    ok: true,
    value: {
      description,
      model: model as AgentModel,
      ...(effort === undefined ? {} : { effort }),
      ...(command === undefined ? {} : { command }),
    },
  };
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
      ...(common.value.effort === undefined ? {} : { effort: common.value.effort }),
      ...(common.value.command === undefined ? {} : { command: common.value.command }),
      tools: parsedTools.tools,
      prompt,
      writeCapability: deriveWriteCapability(parsedTools.tools),
    },
  };
}

/** The Manager definition, which declares its read-only tool set like any worker. */
export function parseManagerAgentDefinition(
  definition: unknown,
): ManagerAgentDefinitionResult {
  const document = splitDefinition(definition);
  if (!document.ok) return document;

  const { frontmatter, prompt } = document.value;
  if (scalarField(frontmatter, "name") !== MANAGER_AGENT_NAME) {
    return { ok: false, reason: "The Manager definition must be named manager" };
  }
  const common = commonFields(frontmatter);
  if (!common.ok) return common;
  const parsedTools = parseAgentDefinitionTools(definition);
  if (!parsedTools.ok) return parsedTools;

  return {
    ok: true,
    value: {
      name: MANAGER_AGENT_NAME,
      description: common.value.description,
      model: common.value.model,
      ...(common.value.effort === undefined ? {} : { effort: common.value.effort }),
      ...(common.value.command === undefined ? {} : { command: common.value.command }),
      tools: parsedTools.tools,
      prompt,
      writeCapability: deriveWriteCapability(parsedTools.tools),
    },
  };
}
