import { join } from "node:path";

import {
  deriveWriteCapability,
  parseAgentDefinitionTools,
  type WriteCapability,
} from "../domain/capability.js";
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel } from "../claude/launch.js";

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
 * instead (spec §5.1.1).
 */
export const AGENT_DEFINITION_DIRECTORY = ".aboard/agents";

/** Absolute path of a definition, from the one directory that holds them. */
export function agentDefinitionPath(workspaceRoot: string, name: string): string {
  return join(workspaceRoot, ...AGENT_DEFINITION_DIRECTORY.split("/"), `${name}.md`);
}

/**
 * Denied on every launch whose definition does not ask for the bridge.
 *
 * `--tools` cannot express this: an MCP server's tools are in the session
 * whether or not the allowlist names them, so a worker would hold
 * `mcp__aboard__run_agent` — the Manager's own launch tool — despite declaring
 * no MCP tools at all. `--disallowedTools` removes them from the session, and
 * they do not reach the agent's context.
 */
export const ABOARD_MCP_TOOLS = "mcp__aboard__*";

/** True when a definition's `tools:` asks for the bridge, as the Manager's does. */
export function declaresAboardMcpTools(tools: readonly string[]): boolean {
  return tools.some((rule) => rule.trim().startsWith("mcp__aboard"));
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
  return {
    ok: true,
    value: {
      description,
      model: model as AgentModel,
      ...(effort === undefined ? {} : { effort }),
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
      tools: parsedTools.tools,
      prompt,
      writeCapability: deriveWriteCapability(parsedTools.tools),
    },
  };
}
