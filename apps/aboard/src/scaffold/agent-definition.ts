import { join } from "node:path";

import {
  deriveWriteCapability,
  parseAgentDefinitionTools,
  type WriteCapability,
} from "../domain/capability.js";
import {
  BY_DIFFICULTY,
  EFFORT_LEVELS,
  isEffortLevel,
  parseClaudeCommand,
  type ByDifficulty,
  type DeclaredEffort,
} from "../claude/launch.js";

/** The Manager runs as the main session agent. */
export const MANAGER_AGENT_NAME = "manager";

export const AGENT_DEFINITION_DIRECTORY = ".abd/agents";


export const NATIVE_SUBAGENT_TYPES = ["Explore", "general-purpose"] as const;

const ABOARD_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "tools",
  "model",
  "effort",
  "command",
]);

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
  "prototyper",
  "webresearcher",
] as const;

/** Claude Code builtins with an aboard-owned launch profile but no copied prompt or tools. */
export const BUILTIN_AGENT_NAMES = ["Explore"] as const;

export const SCAFFOLDED_AGENT_NAMES = [MANAGER_AGENT_NAME, ...WORKER_AGENT_NAMES, ...BUILTIN_AGENT_NAMES] as const;

export type WorkerAgentName = (typeof WORKER_AGENT_NAMES)[number];
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];
export type ScaffoldedAgentName = (typeof SCAFFOLDED_AGENT_NAMES)[number];
export type AgentModel = "opus" | "sonnet" | "haiku" | "fable" | "inherit" | ByDifficulty;
export type AgentEffort = DeclaredEffort;

export interface AgentDefinition {
  readonly name: WorkerAgentName;
  readonly description: string;
  readonly model: AgentModel;
  readonly effort?: AgentEffort;
  readonly command?: readonly string[];
  readonly tools: readonly string[];
  readonly prompt: string;
  readonly writeCapability: WriteCapability;
  /** Lines for keys aboard does not resolve, carried into the rewrite verbatim. */
  readonly extraFrontmatter: readonly string[];
}

export interface ManagerAgentDefinition {
  readonly name: typeof MANAGER_AGENT_NAME;
  readonly description: string;
  readonly model: AgentModel;
  readonly effort?: AgentEffort;
  readonly command?: readonly string[];
  readonly tools: readonly string[];
  readonly prompt: string;
  readonly writeCapability: WriteCapability;
  readonly extraFrontmatter: readonly string[];
}

export interface BuiltinAgentProfile {
  readonly name: BuiltinAgentName;
  readonly description: string;
  readonly model: AgentModel;
  readonly effort?: AgentEffort;
  readonly command?: readonly string[];
}

export type AgentDefinitionResult =
  | { readonly ok: true; readonly value: AgentDefinition }
  | { readonly ok: false; readonly reason: string };

export type ManagerAgentDefinitionResult =
  | { readonly ok: true; readonly value: ManagerAgentDefinition }
  | { readonly ok: false; readonly reason: string };

export type BuiltinAgentProfileResult =
  | { readonly ok: true; readonly value: BuiltinAgentProfile }
  | { readonly ok: false; readonly reason: string };

const MODELS: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku", "fable", "inherit", BY_DIFFICULTY]);

function scalarField(lines: readonly string[], field: string): string | undefined {
  const prefix = `${field}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

const TOP_LEVEL_KEY = /^([A-Za-z0-9_.-]+)\s*:/;

function extraFrontmatter(frontmatter: readonly string[]): readonly string[] {
  const extra: string[] = [];
  let owned = true;
  for (const line of frontmatter) {
    const key = /^\s/.test(line) ? null : TOP_LEVEL_KEY.exec(line);
    if (key !== null) owned = ABOARD_FRONTMATTER_KEYS.has(key[1]!);
    if (!owned) extra.push(line);
  }
  // Trailing blank lines belong to the last unowned key only by adjacency.
  while (extra.length > 0 && extra.at(-1)!.trim().length === 0) extra.pop();
  return extra;
}

interface ParsedDocument {
  readonly frontmatter: readonly string[];
  readonly prompt: string;
}

type DocumentResult =
  | { readonly ok: true; readonly value: ParsedDocument }
  | { readonly ok: false; readonly reason: string };

function splitDefinition(definition: unknown, allowEmptyPrompt = false): DocumentResult {
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
  if (!allowEmptyPrompt && prompt.length === 0) return { ok: false, reason: "Agent system prompt is empty" };
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
  const rawEffort = scalarField(frontmatter, "effort");
  if (rawEffort !== undefined && rawEffort !== BY_DIFFICULTY && !isEffortLevel(rawEffort)) {
    return { ok: false, reason: `Unsupported agent effort: ${rawEffort}. Expected ${BY_DIFFICULTY} or one of ${EFFORT_LEVELS.join(", ")}` };
  }
  const effort = rawEffort as AgentEffort | undefined;
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
      extraFrontmatter: extraFrontmatter(frontmatter),
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
      extraFrontmatter: extraFrontmatter(frontmatter),
    },
  };
}

export function rewriteAgentTools(tools: readonly string[]): readonly string[] {
  return tools.flatMap((rule) =>
    rule.trim() === "Agent" ? NATIVE_SUBAGENT_TYPES.map((type) => `Agent(${type})`) : [rule],
  );
}

export interface SanitizedAgentDefinition {
  readonly description: string;
  readonly tools: readonly string[];
  readonly model: AgentModel;
  readonly effort?: AgentEffort;
  readonly command?: readonly string[];
  readonly prompt: string;
  readonly extraFrontmatter: readonly string[];
  readonly writeCapability: WriteCapability;
}

export function sanitizeAgentDefinition(
  definition: AgentDefinition | ManagerAgentDefinition,
): SanitizedAgentDefinition {
  const tools = rewriteAgentTools(definition.tools);
  return {
    description: definition.description,
    tools,
    model: definition.model,
    ...(definition.effort === undefined ? {} : { effort: definition.effort }),
    ...(definition.command === undefined ? {} : { command: definition.command }),
    prompt: definition.prompt,
    extraFrontmatter: definition.extraFrontmatter,
    writeCapability: deriveWriteCapability(tools),
  };
}

export function parseBuiltinAgentProfile(
  definition: unknown,
): BuiltinAgentProfileResult {
  const document = splitDefinition(definition, true);
  if (!document.ok) return document;

  const { frontmatter, prompt } = document.value;
  const name = scalarField(frontmatter, "name");
  if (!BUILTIN_AGENT_NAMES.includes(name as BuiltinAgentName)) {
    return { ok: false, reason: `Unsupported builtin agent name: ${name ?? "missing"}` };
  }
  if (frontmatter.some((line) => /^\s*tools\s*:/.test(line))) {
    return { ok: false, reason: `The ${name} builtin profile must not declare tools; Claude Code owns its tool set` };
  }
  if (prompt.length > 0) {
    return { ok: false, reason: `The ${name} builtin profile must not contain a system prompt; Claude Code owns it` };
  }
  const common = commonFields(frontmatter);
  if (!common.ok) return common;

  return {
    ok: true,
    value: {
      name: name as BuiltinAgentName,
      description: common.value.description,
      model: common.value.model,
      ...(common.value.effort === undefined ? {} : { effort: common.value.effort }),
      ...(common.value.command === undefined ? {} : { command: common.value.command }),
    },
  };
}
