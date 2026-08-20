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

/**
 * Where aboard keeps its authored agent definitions — deliberately *not*
 * `.claude/agents/`, which Claude Code scans from every session that runs
 * anywhere under the workspace. A definition there is a registered subagent
 * type: the user's own `claude` would see `implementer` and the pr-doctors in
 * its Agent tool and could spawn them outside the bridge and outside the write
 * lease.
 *
 * These files are authored source, never launched directly. Each launch
 * rewrites the one it needs into a per-agent runtime directory that only that
 * launch's `--add-dir` points at (see `sanitizeAgentDefinition` and
 * `agentRuntimeArguments` in `src/claude/launch.ts`), so the definition is a
 * registered subagent inside exactly one session and discoverable by no other.
 */
export const AGENT_DEFINITION_DIRECTORY = ".aboard/agents";

/**
 * There is deliberately no per-role color table here. `color:` is a frontmatter
 * key aboard does not resolve: it is carried through like any other author-owned
 * key and Claude Code renders it. The scaffolded definitions ship one distinct
 * color per role so the fleet convention starts coherent in every workspace;
 * after that the files are the user's to edit.
 */

/**
 * The subagent types a rewritten aboard agent may spawn through its `Agent`
 * tool. A rewritten definition is a registered project subagent *inside its own
 * session*, which makes a bare `Agent` allowance self-spawning — and would also
 * expose any subagent the user's repository defines. The bare rule is therefore
 * narrowed, so `Agent` keeps meaning "delegate to a stock Claude agent" and
 * never "start another aboard worker outside the bridge".
 *
 * The two are the only ones a worker has a use for: `Explore` to read the
 * repository without paying for the files in its own context, and
 * `general-purpose` for work it wants done in a fresh full-tool context. `Plan`,
 * `claude-code-guide`, and `statusline-setup` answer questions no aboard worker
 * is delegating — the last two are configuration assistants — so they are left
 * out rather than granted on the chance one is wanted.
 *
 * aboard's own `general-purpose` mode is the exception, and needs no entry here:
 * it launches as Claude Code's unmodified default session with no rewritten
 * definition at all, so it keeps the whole built-in roster by construction.
 *
 * Each type is its own `Agent(<type>)` rule rather than one rule listing both:
 * `tools:` is a comma-separated scalar, and a rule carrying commas inside its
 * parentheses depends on the reader splitting on commas at paren depth zero.
 * Separate rules mean the same allowlist under any comma-splitting parser.
 */
export const NATIVE_SUBAGENT_TYPES = ["Explore", "general-purpose"] as const;

/**
 * Frontmatter keys aboard resolves itself. Everything else in a definition is
 * copied into the rewritten file verbatim: the user owns these files, an
 * unrecognized key is theirs to add, and Claude Code silently skips a key it
 * does not know. Only broken YAML fails a launch, which is a defect the author
 * sees immediately.
 */
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
  "webresearcher",
  "implementer",
  "pr-doctor-afk",
  "pr-doctor-hitl",
] as const;

/** Claude Code builtins with an aboard-owned launch profile but no copied prompt or tools. */
export const BUILTIN_AGENT_NAMES = ["Explore"] as const;

export const SCAFFOLDED_AGENT_NAMES = [MANAGER_AGENT_NAME, ...WORKER_AGENT_NAMES, ...BUILTIN_AGENT_NAMES] as const;

export type WorkerAgentName = (typeof WORKER_AGENT_NAMES)[number];
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];
export type ScaffoldedAgentName = (typeof SCAFFOLDED_AGENT_NAMES)[number];
/**
 * The definition's `model:` field. `by-difficulty` defers to the difficulty
 * label on the issue the launch is working, and `inherit` defers to Claude
 * Code's own setting; every other value is the agent's own final answer
 * (`src/claude/launch.ts`).
 */
export type AgentModel = "opus" | "sonnet" | "haiku" | "fable" | "inherit" | ByDifficulty;
/**
 * The definition's `effort:` field. Unlike `model:` it is optional, because an
 * absent field is a meaningful value rather than an omission: the agent inherits
 * the session's effort level, which is what `aboard.launch.effort` sets. It
 * takes `by-difficulty` independently of `model:`, so an agent may route one
 * and pin the other.
 */
export type AgentEffort = DeclaredEffort;

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
  /** Lines for keys aboard does not resolve, carried into the rewrite verbatim. */
  readonly extraFrontmatter: readonly string[];
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
  readonly extraFrontmatter: readonly string[];
}

/**
 * Launch policy layered over a Claude Code builtin. It deliberately has no
 * prompt or tool fields: `--agent Explore` remains the sole authority for both.
 */
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

/**
 * The frontmatter lines belonging to keys aboard does not resolve, in source
 * order and byte for byte.
 *
 * Ownership is tracked rather than matched per line, because a key's value may
 * span lines — a `hooks:` mapping, a block scalar, a YAML sequence — and those
 * continuation lines carry no key of their own. A line at column zero that
 * looks like `key:` opens a new key; anything else, blank lines included,
 * continues the key above it.
 */
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
  // `command:` overrides `aboard.launch.claudeCommand` for this agent alone —
  // one agent behind a provider wrapper (`wrapper run MyProfile --`) while the rest
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

/**
 * Narrows a bare `Agent` allowance to Claude Code's native subagent types, and
 * leaves every other rule — including an `Agent(...)` the definition already
 * scoped for itself — exactly as written. See `NATIVE_SUBAGENT_TYPES`.
 */
export function rewriteAgentTools(tools: readonly string[]): readonly string[] {
  return tools.flatMap((rule) =>
    rule.trim() === "Agent" ? NATIVE_SUBAGENT_TYPES.map((type) => `Agent(${type})`) : [rule],
  );
}

/**
 * The definition as it is written into the per-launch runtime directory: the
 * same document with its tool list narrowed, and every key aboard does not
 * resolve copied through untouched.
 *
 * It carries no name, because the name is per-launch — `aboard-<type>-<agentId>`,
 * minted by the planner that also owns the `--add-dir` the file sits under. A
 * unique name is what makes a collision with a project or user subagent of the
 * same role name structurally impossible.
 *
 * Capability is derived from the *rewritten* list, so the tools the launch
 * really grants are the tools the lease reasons about.
 */
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

/**
 * Parses the metadata-only profile for a named Claude Code builtin. A prompt
 * body or `tools:` field would shadow policy Claude owns, so both are rejected
 * instead of being silently ignored.
 */
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
