
import { deriveWriteCapability, type WriteCapability } from "../domain/capability.js";
import {
  isAutomatedAgentType,
  isNamedBuiltinAgentType,
  isInteractiveAgentType,
  type AgentId,
  type AgentType,
  type SessionId,
} from "../domain/contracts.js";
import { ABOARD_MCP_SERVER_NAME, aboardToolNamesForRole } from "../bridge/mcp-tools.js";
import type { IssueDifficulty } from "../shared/labels.js";
import {
  describeResolvedPrompt,
  resolvedPromptFromText,
  type ResolvedPrompt,
} from "./prompts.js";
import { buildCommandLine, canQuoteArgument, type ShellKind } from "./shell.js";

export const DEFAULT_CLAUDE_COMMAND = ["claude"] as const;
export const DEFAULT_RUNTIME_DIRECTORY = ".aboard/runtime";
/** `aboard.launch.maxInlinePromptChars` — conservative, below every known ceiling. */
export const DEFAULT_MAX_INLINE_PROMPT_CHARS = 4000;

export const MAX_COMMAND_LINE_CHARS: Readonly<Record<ShellKind, number>> = {
  cmd: 8_000,
  powershell: 24_000,
  "git-bash": 24_000,
};

/** The scaffolded definition the Manager session runs from. */
export const MANAGER_AGENT_NAME = "manager";

export type ClaudeCommandResult =
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function parseClaudeCommand(value: unknown): ClaudeCommandResult {
  if (Array.isArray(value)) {
    if (!value.every((token): token is string => typeof token === "string")) {
      return { ok: false, reason: "Launch command array must contain only strings" };
    }
    const tokens = value.map((token) => token.trim()).filter((token) => token.length > 0);
    return tokens.length === 0
      ? { ok: false, reason: "Launch command is empty" }
      : { ok: true, value: tokens };
  }
  if (typeof value !== "string") return { ok: false, reason: "Launch command must be a string or an array of strings" };

  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  for (const character of value) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== undefined) return { ok: false, reason: "Launch command has an unterminated quote" };
  if (started) tokens.push(current);
  return tokens.length === 0
    ? { ok: false, reason: "Launch command is empty" }
    : { ok: true, value: tokens };
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVEL_SET.has(value);
}

export const BY_DIFFICULTY = "by-difficulty";
export type ByDifficulty = typeof BY_DIFFICULTY;

/** A definition's `effort:`, which may defer to the issue's difficulty. */
export type DeclaredEffort = EffortLevel | ByDifficulty;

export interface DifficultyLaunchPolicy {
  readonly model: string;
  readonly effort: EffortLevel;
}

export const DIFFICULTY_LAUNCH_POLICIES: { readonly [K in IssueDifficulty]: DifficultyLaunchPolicy } = {
  routine: { model: "haiku", effort: "medium" },
  basic: { model: "sonnet", effort: "high" },
  advanced: { model: "opus", effort: "medium" },
  expert: { model: "opus", effort: "high" },
};

export function difficultyLaunchPolicy(difficulty: IssueDifficulty | undefined): DifficultyLaunchPolicy {
  return DIFFICULTY_LAUNCH_POLICIES[difficulty ?? "expert"];
}

interface ResolvedLaunchPolicy {
  readonly declaredModel: string | undefined;
  readonly declaredEffort: EffortLevel | undefined;
  /** What the command line carries — the declaration, or the session default behind it. */
  readonly model: string | undefined;
  readonly effort: EffortLevel | undefined;
}

function launchPolicy(
  declared: { readonly declaredModel?: string | undefined; readonly declaredEffort?: DeclaredEffort | undefined },
  request: { readonly model?: string | undefined; readonly effort?: EffortLevel | undefined; readonly difficulty?: IssueDifficulty | undefined },
): ResolvedLaunchPolicy {
  const tier = difficultyLaunchPolicy(request.difficulty);
  const declaredModel = declared.declaredModel === BY_DIFFICULTY ? tier.model : declared.declaredModel;
  const declaredEffort = declared.declaredEffort === BY_DIFFICULTY ? tier.effort : declared.declaredEffort;
  return {
    declaredModel,
    declaredEffort,
    model: declaredModel ?? request.model,
    effort: declaredEffort ?? request.effort,
  };
}

export type LaunchConfiguration =
  | {
      readonly shape: "agent-defined";
      readonly agentName: string;
      /** The definition body, written as the rewritten file's markdown body. */
      readonly systemPrompt: string;
      readonly declaredTools: readonly string[];
      /** `description:` from the same definition; a required frontmatter field. */
      readonly declaredDescription?: string;
      readonly extraFrontmatter?: readonly string[];
      readonly declaredModel?: string;
      readonly declaredEffort?: DeclaredEffort;
      readonly declaredCommand?: readonly string[];
    }
  | {
      readonly shape: "builtin";
      readonly agentName: string;
      readonly declaredModel?: string;
      readonly declaredEffort?: DeclaredEffort;
      readonly declaredCommand?: readonly string[];
    }
  /** Claude Code's unmodified default session, exposed as `general-purpose`. */
  | { readonly shape: "default" };

/** The flat shape a caller supplies, so the exclusive pair can be rejected. */
export interface LaunchConfigurationInput {
  readonly agentName?: string | undefined;
  /** Present only for a complete aboard-owned agent definition. */
  readonly systemPrompt?: string | undefined;
  readonly declaredTools?: readonly string[] | undefined;
  readonly declaredDescription?: string | undefined;
  readonly extraFrontmatter?: readonly string[] | undefined;
  readonly declaredModel?: string | undefined;
  readonly declaredEffort?: DeclaredEffort | undefined;
  readonly declaredCommand?: readonly string[] | undefined;
  /** Rejected for builtins; retained here so the invalid combination is typed. */
  readonly tools?: readonly string[] | undefined;
}

export type LaunchPlanErrorCode =
  | "conflicting-launch-shape"
  | "declared-tools-without-agent"
  | "missing-declared-tools"
  | "missing-system-prompt"
  | "invalid-agent-name"
  | "invalid-tool-rule"
  | "invalid-model"
  | "invalid-effort"
  | "invalid-frontmatter"
  | "invalid-session-id"
  | "unsafe-agent-id"
  | "unsafe-spill-path"
  | "invalid-threshold"
  | "invalid-command"
  | "invalid-mcp-config"
  | "command-line-too-long"
  | "missing-prompt"
  | "shape-not-allowed";

export class LaunchPlanError extends Error {
  public constructor(
    public readonly code: LaunchPlanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveLaunchConfiguration(
  input: LaunchConfigurationInput,
): LaunchConfiguration {
  if (input.agentName !== undefined) {
    if (input.tools !== undefined) {
      throw new LaunchPlanError(
        "conflicting-launch-shape",
        "--agent cannot be combined with --tools",
      );
    }
    if (!AGENT_NAME_PATTERN.test(input.agentName)) {
      throw new LaunchPlanError(
        "invalid-agent-name",
        `Invalid agent definition name: ${input.agentName}`,
      );
    }
    const declaredModel =
      input.declaredModel === undefined || input.declaredModel === "inherit"
        ? undefined
        : assertFlagValue(input.declaredModel, "invalid-model", "agent model");
    if (
      input.declaredEffort !== undefined &&
      input.declaredEffort !== BY_DIFFICULTY &&
      !isEffortLevel(input.declaredEffort)
    ) {
      throw new LaunchPlanError(
        "invalid-effort",
        `Agent effort must be ${BY_DIFFICULTY} or one of ${EFFORT_LEVELS.join(", ")}: ${JSON.stringify(input.declaredEffort)}`,
      );
    }
    const declaredCommand =
      input.declaredCommand === undefined || input.declaredCommand.length === 0
        ? undefined
        : input.declaredCommand.map((token) =>
            assertFlagValue(token, "invalid-command", "agent command token", { allowLeadingDash: true }),
          );

    // A builtin profile never supplies a prompt or tools. Claude Code resolves
    // both through `--agent`; aboard passes only the policy fields above.
    if (input.systemPrompt === undefined) {
      if (input.declaredTools !== undefined) {
        throw new LaunchPlanError(
          "conflicting-launch-shape",
          `The ${input.agentName} builtin profile must not declare tools`,
        );
      }
      if (
        input.declaredDescription !== undefined ||
        input.extraFrontmatter !== undefined
      ) {
        throw new LaunchPlanError(
          "conflicting-launch-shape",
          `The ${input.agentName} builtin profile is launch policy only; Claude Code owns its definition`,
        );
      }
      return {
        shape: "builtin",
        agentName: input.agentName,
        ...(declaredModel === undefined ? {} : { declaredModel }),
        ...(input.declaredEffort === undefined ? {} : { declaredEffort: input.declaredEffort }),
        ...(declaredCommand === undefined ? {} : { declaredCommand }),
      };
    }

    if (!AGENT_ID_PATTERN.test(input.agentName)) {
      throw new LaunchPlanError(
        "invalid-agent-name",
        `An aboard agent definition name must be a single path segment: ${input.agentName}`,
      );
    }
    if (input.systemPrompt.trim().length === 0) {
      throw new LaunchPlanError(
        "missing-system-prompt",
        `The ${input.agentName} agent definition has an empty system prompt`,
      );
    }
    if (input.declaredTools === undefined || input.declaredTools.length === 0) {
      // Without `tools:` there is no allowlist to pass, so no `--tools` flag is
      // emitted; an empty allowlist must not disable every tool or inherit one.
      throw new LaunchPlanError(
        "missing-declared-tools",
        `The ${input.agentName} agent definition declares no tools`,
      );
    }
    for (const line of input.extraFrontmatter ?? []) {
      if (line.includes("\n") || line.includes("\r") || /^\s*(?:---|\.\.\.)\s*$/.test(line)) {
        throw new LaunchPlanError(
          "invalid-frontmatter",
          `Agent frontmatter line cannot be carried through: ${JSON.stringify(line)}`,
        );
      }
    }
    return {
      shape: "agent-defined",
      agentName: input.agentName,
      systemPrompt: input.systemPrompt,
      declaredTools: input.declaredTools,
      ...(input.declaredDescription === undefined ? {} : { declaredDescription: input.declaredDescription }),
      ...(input.extraFrontmatter === undefined || input.extraFrontmatter.length === 0
        ? {}
        : { extraFrontmatter: input.extraFrontmatter }),
      ...(declaredModel === undefined ? {} : { declaredModel }),
      ...(input.declaredEffort === undefined ? {} : { declaredEffort: input.declaredEffort }),
      ...(declaredCommand === undefined ? {} : { declaredCommand }),
    };
  }

  if (
    input.systemPrompt !== undefined ||
    input.declaredTools !== undefined ||
    input.declaredDescription !== undefined ||
    input.extraFrontmatter !== undefined ||
    input.declaredModel !== undefined ||
    input.declaredEffort !== undefined ||
    input.declaredCommand !== undefined
  ) {
    throw new LaunchPlanError(
      "declared-tools-without-agent",
      "declared fields describe an agent definition and require agentName",
    );
  }
  if (input.tools !== undefined) {
    throw new LaunchPlanError(
      "conflicting-launch-shape",
      "The default Claude Code session cannot be combined with --tools",
    );
  }
  return { shape: "default" };
}

export function launchWriteCapability(
  agentType: AgentType,
  configuration: LaunchConfiguration,
): WriteCapability {
  if (agentType === "Explore") return "read-only";
  if (agentType === "general-purpose") return "write-capable";
  switch (configuration.shape) {
    case "agent-defined":
      return deriveWriteCapability(configuration.declaredTools);
    // A builtin has no readable tool set, which is unknown capability and
    // therefore the restrictive answer.
    case "builtin":
      return deriveWriteCapability(undefined);
    case "default":
      return deriveWriteCapability(undefined);
  }
}

export function requiresWriteLease(
  agentType: AgentType,
  capability: WriteCapability,
): boolean {
  return agentType !== "manager" && capability === "write-capable";
}

/** A file the plan needs on disk before its command line can run. */
export interface RuntimeFile {
  readonly agentId: AgentId;
  /** Workspace-relative, POSIX separators. */
  readonly relativePath: string;
  readonly contents: string;
}

/** The relative path is the exact text after `@`, so it carries no whitespace. */
export type PromptSpillFile = RuntimeFile;

export type AgentDefinitionFile = RuntimeFile;

/** Exact child argv consumed by the wrapper before it starts Claude. */
export type WrapperRequestFile = RuntimeFile;

export type PromptDelivery = "none" | "inline" | "spilled";

export interface LaunchPlan {
  readonly kind: "start" | "resume";
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly shell: ShellKind;
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly writeCapability: WriteCapability;
  readonly requiresWriteLease: boolean;
  readonly promptDelivery: PromptDelivery;
  readonly spill?: PromptSpillFile;
  readonly agentDefinition?: AgentDefinitionFile;
  readonly wrapperRequest?: WrapperRequestFile;
  /** Per-launch directory selected with `--settings` and `--add-dir`. */
  readonly runtimeDirectory: string;
}

interface CommonPlanRequest {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly shell: ShellKind;
  readonly attended?: boolean | undefined;
  readonly model?: string | undefined;
  readonly effort?: EffortLevel | undefined;
  readonly difficulty?: IssueDifficulty | undefined;
  readonly command?: readonly string[] | undefined;
  readonly mcpConfigPath?: string | undefined;
  /** Set only for an auto-run implementer whose frozen issue has `[AI]-chrome`. */
  readonly chrome?: true | undefined;
  readonly maxInlinePromptChars?: number | undefined;
  readonly runtimeDirectory?: string | undefined;
  readonly wrapper?: SessionWrapperLayout | undefined;
}

export interface SessionWrapperLayout {
  /** Absolute path of the scaffolded wrapper script. */
  readonly script: string;
  /** Per-agent marker path the wrapper owns (`lockFile` in the request). */
  lockPathFor(agentId: AgentId): string;
}

export interface LaunchPlanRequest extends CommonPlanRequest {
  readonly configuration: LaunchConfiguration;
  /** Required for automated types, optional for interactive ones (5.3, 5.4). */
  readonly prompt?: ResolvedPrompt | string | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
}

export type ManagerResumePlanRequest = Omit<CommonPlanRequest, "agentType"> & {
  readonly configuration: LaunchConfiguration;
  readonly disallowedTools?: readonly string[] | undefined;
};

export interface SessionResumePlanRequest extends CommonPlanRequest {
  readonly configuration: LaunchConfiguration;
  /** Optional first message for a continuation; ordinary reopen leaves this absent. */
  readonly prompt?: ResolvedPrompt | string | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
}

function assertFlagValue(
  value: string,
  code: LaunchPlanErrorCode,
  description: string,
  options: { readonly allowLeadingDash?: boolean } = {},
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || (trimmed.startsWith("-") && options.allowLeadingDash !== true)) {
    throw new LaunchPlanError(code, `Invalid ${description}: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

function assertMcpConfigShape(
  path: string | undefined,
  configuration: LaunchConfiguration,
): string | undefined {
  if (path !== undefined && configuration.shape !== "agent-defined") {
    throw new LaunchPlanError(
      "shape-not-allowed",
      "An MCP registration is carried only by an aboard agent definition launch",
    );
  }
  return path;
}

function mcpConfigArguments(path: string | undefined): readonly string[] {
  if (path === undefined) return [];
  return ["--mcp-config", assertFlagValue(path, "invalid-mcp-config", "MCP config path")];
}

function aboardMcpAllowRules(agentType: AgentType, configuration: LaunchConfiguration): readonly string[] {
  if (configuration.shape !== "agent-defined") return [];
  const declaresAboard = configuration.declaredTools.some(
    (rule) => rule.trim() === `mcp__${ABOARD_MCP_SERVER_NAME}__*`,
  );
  return declaresAboard ? aboardToolNamesForRole(agentType) : [];
}

function toolListArguments(
  flag: string,
  rules: readonly string[] | undefined,
): readonly string[] {
  if (rules === undefined || rules.length === 0) return [];
  const list = rules.map((rule) => assertFlagValue(rule, "invalid-tool-rule", "tool rule")).join(",");
  return [flag, list];
}

function modelArguments(model: string | undefined): readonly string[] {
  if (model === undefined) return [];
  return ["--model", assertFlagValue(model, "invalid-model", "model")];
}

function effortArguments(effort: EffortLevel | undefined): readonly string[] {
  if (effort === undefined) return [];
  if (!isEffortLevel(effort)) {
    throw new LaunchPlanError(
      "invalid-effort",
      `Effort must be one of ${EFFORT_LEVELS.join(", ")}: ${JSON.stringify(effort)}`,
    );
  }
  return ["--effort", effort];
}

function slashCommandArguments(attended: boolean): readonly string[] {
  return attended ? [] : ["--disable-slash-commands"];
}

function chromeArguments(agentType: AgentType, enabled: true | undefined): readonly string[] {
  if (enabled !== true) return [];
  if (agentType !== "implementer") {
    throw new LaunchPlanError(
      "shape-not-allowed",
      `Claude in Chrome is available only to [AI]-chrome auto-run implementers: ${agentType}`,
    );
  }
  return ["--chrome"];
}

function normalizePrompt(
  prompt: ResolvedPrompt | string | undefined,
): ResolvedPrompt | undefined {
  if (prompt === undefined) return undefined;
  const resolved = typeof prompt === "string" ? resolvedPromptFromText(prompt) : prompt;
  return resolved.text.trim().length === 0 ? undefined : resolved;
}

function spillRelativePath(runtimeDirectory: string, stem: string): string {
  const directory = runtimeDirectory.replaceAll("\\", "/").replace(/\/+$/, "");
  const path = `${directory}/prompts/${stem}.md`;
  // `@path` expansion has no quoting of its own, so the reference must not
  // contain whitespace even when the surrounding argument is quoted.
  if (/\s/.test(path)) {
    throw new LaunchPlanError(
      "unsafe-spill-path",
      `Prompt spill path must not contain whitespace: ${path}`,
    );
  }
  return path;
}

function agentRuntimeDirectory(runtimeDirectory: string, agentId: AgentId): string {
  const directory = runtimeDirectory.replaceAll("\\", "/").replace(/\/+$/, "");
  return `${directory}/agents/${agentId}`;
}

export function runtimeAgentName(agentName: string, agentId: AgentId): string {
  return `aboard-${agentName}-${agentId}`;
}

/** One `key: value` line, or nothing when the value is absent. */
function frontmatterLine(key: string, value: string | undefined): readonly string[] {
  return value === undefined ? [] : [`${key}: ${value}`];
}

function renderAgentDefinition(
  configuration: Extract<LaunchConfiguration, { shape: "agent-defined" }>,
  name: string,
  policy: ResolvedLaunchPolicy,
): string {
  const frontmatter = [
    `name: ${name}`,
    `description: ${configuration.declaredDescription ?? `aboard ${configuration.agentName} agent`}`,
    `tools: ${configuration.declaredTools.join(", ")}`,
    ...frontmatterLine("model", policy.declaredModel),
    ...frontmatterLine("effort", policy.declaredEffort),
    ...(configuration.extraFrontmatter ?? []),
  ];
  return `---\n${frontmatter.join("\n")}\n---\n\n${configuration.systemPrompt.trim()}\n`;
}

function agentRuntimeArguments(
  configuration: Extract<LaunchConfiguration, { shape: "agent-defined" }>,
  agentId: AgentId,
  runtimeDirectory: string,
  policy: ResolvedLaunchPolicy,
): { readonly args: readonly string[]; readonly file: AgentDefinitionFile } {
  const directory = agentRuntimeDirectory(runtimeDirectory, agentId);
  const name = runtimeAgentName(configuration.agentName, agentId);
  return {
    args: ["--agent", name],
    file: {
      agentId,
      relativePath: `${directory}/.claude/agents/${name}.md`,
      contents: renderAgentDefinition(configuration, name, policy),
    },
  };
}

function denyRules(requested: readonly string[] | undefined): readonly string[] {
  return [...new Set(requested ?? [])];
}

interface PromptPlan {
  readonly delivery: PromptDelivery;
  readonly args: readonly string[];
  readonly spill?: PromptSpillFile;
}

function planPrompt(
  prompt: ResolvedPrompt | undefined,
  options: {
    readonly agentId: AgentId;
    readonly shell: ShellKind;
    readonly threshold: number;
    readonly runtimeDirectory: string;
    readonly stem: string;
  },
): PromptPlan {
  if (prompt === undefined) return { delivery: "none", args: [] };

  const text = prompt.text.trim();
  if (text.length <= options.threshold && canQuoteArgument(options.shell, text)) {
    return { delivery: "inline", args: [text] };
  }

  const relativePath = spillRelativePath(options.runtimeDirectory, options.stem);
  const reference = `Your full task is in @${relativePath} — read it first.`;
  const withHeadline = `${prompt.headline} ${reference}`;
  const stub =
    withHeadline.length <= options.threshold && canQuoteArgument(options.shell, withHeadline)
      ? withHeadline
      : reference;

  return {
    delivery: "spilled",
    args: [stub],
    spill: { agentId: options.agentId, relativePath, contents: `${text}\n` },
  };
}

function effectiveCommand(
  configuration: LaunchConfiguration,
  configured: readonly string[] | undefined,
): readonly string[] {
  if (configuration.shape !== "default" && configuration.declaredCommand !== undefined) {
    return configuration.declaredCommand;
  }
  return configured === undefined || configured.length === 0 ? [...DEFAULT_CLAUDE_COMMAND] : configured;
}

function commonPreconditions(
  request: CommonPlanRequest,
  configuration: LaunchConfiguration,
): {
  readonly command: readonly string[];
  readonly threshold: number;
  readonly runtimeDirectory: string;
  readonly wrapper: SessionWrapperLayout | undefined;
  readonly attended: boolean;
} {
  if (!AGENT_ID_PATTERN.test(request.agentId)) {
    throw new LaunchPlanError(
      "unsafe-agent-id",
      `Agent id is not safe as a file name: ${request.agentId}`,
    );
  }
  if (!SESSION_ID_PATTERN.test(request.sessionId)) {
    // Session IDs are minted before launch and imposed with --session-id (5.2);
    // anything else means the caller never minted one.
    throw new LaunchPlanError(
      "invalid-session-id",
      "Session id must be a UUID minted before launch",
    );
  }
  const threshold = request.maxInlinePromptChars ?? DEFAULT_MAX_INLINE_PROMPT_CHARS;
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new LaunchPlanError(
      "invalid-threshold",
      "maxInlinePromptChars must be a non-negative integer",
    );
  }
  const command = effectiveCommand(configuration, request.command);
  for (const token of command) {
    if (token.trim().length === 0 || !canQuoteArgument(request.shell, token)) {
      throw new LaunchPlanError(
        "invalid-command",
        `Launch command token cannot be passed on a ${request.shell} command line: ${JSON.stringify(token)}`,
      );
    }
  }
  const wrapper = request.wrapper;
  if (wrapper !== undefined) {
    for (const token of [wrapper.script, wrapper.lockPathFor(request.agentId)]) {
      if (token.trim().length === 0 || !canQuoteArgument(request.shell, token)) {
        throw new LaunchPlanError(
          "invalid-command",
          `Wrapper token cannot be passed on a ${request.shell} command line: ${JSON.stringify(token)}`,
        );
      }
    }
  }
  const attended =
    request.attended ?? (request.agentType === "manager" || isInteractiveAgentType(request.agentType));
  return {
    command,
    threshold,
    runtimeDirectory: request.runtimeDirectory ?? DEFAULT_RUNTIME_DIRECTORY,
    wrapper,
    attended,
  };
}

function wrapperRequestFile(
  runtimeDirectory: string,
  agentId: AgentId,
  command: readonly string[],
  args: readonly string[],
): WrapperRequestFile {
  return {
    agentId,
    relativePath: `${agentRuntimeDirectory(runtimeDirectory, agentId)}/launch.json`,
    contents: `${JSON.stringify({ command: [...command, ...args] })}\n`,
  };
}

/** The wrapper executable plus short paths; child argv stays out of terminal input. */
function wrapCommand(
  command: readonly string[],
  args: readonly string[],
  wrapper: SessionWrapperLayout | undefined,
  agentId: AgentId,
  runtimeDirectory: string,
): { readonly command: readonly string[]; readonly args: readonly string[]; readonly request?: WrapperRequestFile } {
  if (wrapper === undefined) return { command, args };
  const request = wrapperRequestFile(runtimeDirectory, agentId, command, args);
  return {
    command: ["uv", "run", "--no-project", "--no-managed-python", wrapper.script],
    args: [wrapper.lockPathFor(agentId), "--request", request.relativePath],
    request,
  };
}

export function planLaunch(request: LaunchPlanRequest): LaunchPlan {
  const { command, threshold, runtimeDirectory, wrapper, attended } = commonPreconditions(request, request.configuration);
  const { agentType, configuration } = request;

  if (agentType === "manager") {
    // The Manager's persona and tool list both live in
    // .aboard/agents/manager.md; it never launches from a bare tool list.
    if (
      configuration.shape !== "agent-defined" ||
      configuration.agentName !== MANAGER_AGENT_NAME
    ) {
      throw new LaunchPlanError(
        "shape-not-allowed",
        "The Manager launches from .aboard/agents/manager.md",
      );
    }
  }
  if (agentType === "general-purpose" && configuration.shape !== "default") {
    throw new LaunchPlanError(
      "shape-not-allowed",
      "general-purpose launches as Claude Code's default session without --agent or a system prompt",
    );
  }
  if (agentType !== "general-purpose" && configuration.shape === "default") {
    throw new LaunchPlanError(
      "shape-not-allowed",
      `Only general-purpose launches as Claude Code's default session: ${agentType}`,
    );
  }
  if (isNamedBuiltinAgentType(agentType) !== (configuration.shape === "builtin")) {
    throw new LaunchPlanError(
      "shape-not-allowed",
      `Only Claude Code's builtin agent types launch with --agent: ${agentType}`,
    );
  }

  const prompt = normalizePrompt(request.prompt);
  if (prompt === undefined && isAutomatedAgentType(agentType)) {
    // An automated worker with no first message sits at an empty TUI forever,
    // and 5.1.3 forbids the only mechanism that could rescue it.
    throw new LaunchPlanError(
      "missing-prompt",
      `An automated ${agentType} cannot launch without a prompt`,
    );
  }

  const launchRuntimeDirectory = agentRuntimeDirectory(runtimeDirectory, request.agentId);
  const shapeArguments: string[] = [
    ...mcpConfigArguments(assertMcpConfigShape(request.mcpConfigPath, configuration)),
    "--add-dir", launchRuntimeDirectory,
    "--settings", `${launchRuntimeDirectory}/settings.json`,
  ];
  const policy = launchPolicy(configuration.shape === "default" ? {} : configuration, request);

  let agentDefinition: AgentDefinitionFile | undefined;
  switch (configuration.shape) {
    case "agent-defined": {
      const definition = agentRuntimeArguments(configuration, request.agentId, runtimeDirectory, policy);
      shapeArguments.push(...definition.args);
      agentDefinition = definition.file;
      break;
    }
    case "builtin":
      shapeArguments.push("--agent", configuration.agentName);
      break;
    case "default":
      break;
  }

  const fixedArguments = [
    "--session-id",
    request.sessionId,
    ...shapeArguments,
    ...toolListArguments("--allowedTools", aboardMcpAllowRules(agentType, configuration)),
    ...toolListArguments("--disallowedTools", denyRules(request.disallowedTools)),
    ...modelArguments(policy.model),
    ...effortArguments(policy.effort),
    ...chromeArguments(agentType, request.chrome),
    ...slashCommandArguments(attended),
  ];

  const planFor = (promptThreshold: number): { readonly plan: PromptPlan; readonly args: string[]; readonly commandLine: string; readonly request?: WrapperRequestFile } => {
    const plan = planPrompt(prompt, {
      agentId: request.agentId,
      shell: request.shell,
      threshold: promptThreshold,
      runtimeDirectory,
      stem: request.agentId,
    });
    const args = [...fixedArguments, ...plan.args];
    const wrapped = wrapCommand(command, args, wrapper, request.agentId, runtimeDirectory);
    return {
      plan,
      args,
      commandLine: buildCommandLine(request.shell, wrapped.command, wrapped.args),
      ...(wrapped.request === undefined ? {} : { request: wrapped.request }),
    };
  };

  const limit = MAX_COMMAND_LINE_CHARS[request.shell];
  let built = planFor(threshold);
  if (built.commandLine.length > limit && built.plan.delivery === "inline") built = planFor(0);
  if (built.commandLine.length > limit) {
    throw new LaunchPlanError(
      "command-line-too-long",
      `Launch command line is ${built.commandLine.length} characters, over the ${limit} the ${request.shell} shell accepts, even with the prompt spilled to a file. Shorten the deny-tool list or the launch command.`,
    );
  }
  const { plan: promptPlan, args } = built;

  const capability = launchWriteCapability(agentType, configuration);
  return {
    kind: "start",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType,
    shell: request.shell,
    command,
    args,
    commandLine: built.commandLine,
    writeCapability: capability,
    requiresWriteLease: requiresWriteLease(agentType, capability),
    promptDelivery: promptPlan.delivery,
    runtimeDirectory: launchRuntimeDirectory,
    ...(promptPlan.spill === undefined ? {} : { spill: promptPlan.spill }),
    ...(agentDefinition === undefined ? {} : { agentDefinition }),
    ...(built.request === undefined ? {} : { wrapperRequest: built.request }),
  };
}

export function planManagerResume(request: ManagerResumePlanRequest): LaunchPlan {
  const { command, wrapper, runtimeDirectory, attended } = commonPreconditions({ ...request, agentType: "manager" }, request.configuration);
  if (
    request.configuration.shape !== "agent-defined" ||
    request.configuration.agentName !== MANAGER_AGENT_NAME
  ) {
    throw new LaunchPlanError(
      "shape-not-allowed",
      "The Manager resumes from .aboard/agents/manager.md",
    );
  }
  const policy = launchPolicy(request.configuration, request);
  const definition = agentRuntimeArguments(request.configuration, request.agentId, runtimeDirectory, policy);
  const launchRuntimeDirectory = agentRuntimeDirectory(runtimeDirectory, request.agentId);
  const args = [
    "--resume",
    request.sessionId,
    ...mcpConfigArguments(assertMcpConfigShape(request.mcpConfigPath, request.configuration)),
    "--add-dir", launchRuntimeDirectory,
    "--settings", `${launchRuntimeDirectory}/settings.json`,
    ...definition.args,
    // Re-passed like every other launch flag: a resumed Manager that lost the
    // pre-approvals would stall behind the same prompts the launch avoided.
    ...toolListArguments("--allowedTools", aboardMcpAllowRules("manager", request.configuration)),
    ...toolListArguments("--disallowedTools", denyRules(request.disallowedTools)),
    ...modelArguments(policy.model),
    ...effortArguments(policy.effort),
    ...slashCommandArguments(attended),
  ];
  const wrapped = wrapCommand(command, args, wrapper, request.agentId, runtimeDirectory);
  return {
    kind: "resume",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType: "manager",
    shell: request.shell,
    command,
    args,
    commandLine: buildCommandLine(request.shell, wrapped.command, wrapped.args),
    writeCapability: "read-only",
    requiresWriteLease: false,
    promptDelivery: "none",
    runtimeDirectory: launchRuntimeDirectory,
    agentDefinition: definition.file,
    ...(wrapped.request === undefined ? {} : { wrapperRequest: wrapped.request }),
  };
}

export function planSessionResume(request: SessionResumePlanRequest): LaunchPlan {
  const { command, wrapper, runtimeDirectory, attended, threshold } = commonPreconditions(request, request.configuration);
  const { configuration } = request;
  const policy = launchPolicy(configuration.shape === "default" ? {} : configuration, request);
  const definition = configuration.shape === "agent-defined"
    ? agentRuntimeArguments(configuration, request.agentId, runtimeDirectory, policy)
    : undefined;
  const launchRuntimeDirectory = agentRuntimeDirectory(runtimeDirectory, request.agentId);
  // Claude Code restores a builtin's `--agent` selection with the conversation.
  const shapeArguments = [
    ...mcpConfigArguments(assertMcpConfigShape(request.mcpConfigPath, configuration)),
    "--add-dir", launchRuntimeDirectory,
    "--settings", `${launchRuntimeDirectory}/settings.json`,
    ...(definition?.args ?? []),
  ];
  const fixedArguments = [
    "--resume",
    request.sessionId,
    ...shapeArguments,
    ...toolListArguments("--allowedTools", aboardMcpAllowRules(request.agentType, configuration)),
    ...toolListArguments("--disallowedTools", denyRules(request.disallowedTools)),
    ...modelArguments(policy.model),
    ...effortArguments(policy.effort),
    ...chromeArguments(request.agentType, request.chrome),
    ...slashCommandArguments(attended),
  ];
  const prompt = normalizePrompt(request.prompt);
  const planFor = (promptThreshold: number): { readonly promptPlan: PromptPlan; readonly args: string[]; readonly commandLine: string; readonly request?: WrapperRequestFile } => {
    const promptPlan = planPrompt(prompt, {
      agentId: request.agentId,
      shell: request.shell,
      threshold: promptThreshold,
      runtimeDirectory,
      stem: `${request.agentId}-continue`,
    });
    const args = [...fixedArguments, ...promptPlan.args];
    const wrapped = wrapCommand(command, args, wrapper, request.agentId, runtimeDirectory);
    return {
      promptPlan,
      args,
      commandLine: buildCommandLine(request.shell, wrapped.command, wrapped.args),
      ...(wrapped.request === undefined ? {} : { request: wrapped.request }),
    };
  };
  const limit = MAX_COMMAND_LINE_CHARS[request.shell];
  let built = planFor(threshold);
  if (built.commandLine.length > limit && built.promptPlan.delivery === "inline") built = planFor(0);
  if (built.commandLine.length > limit) {
    throw new LaunchPlanError(
      "command-line-too-long",
      `Resume command line is ${built.commandLine.length} characters, over the ${limit} the ${request.shell} shell accepts, even with the prompt spilled to a file.`,
    );
  }
  const capability = launchWriteCapability(request.agentType, configuration);
  return {
    kind: "resume",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType: request.agentType,
    shell: request.shell,
    command,
    args: built.args,
    commandLine: built.commandLine,
    writeCapability: capability,
    requiresWriteLease: requiresWriteLease(request.agentType, capability),
    promptDelivery: built.promptPlan.delivery,
    runtimeDirectory: launchRuntimeDirectory,
    ...(built.promptPlan.spill === undefined ? {} : { spill: built.promptPlan.spill }),
    ...(definition === undefined ? {} : { agentDefinition: definition.file }),
    ...(built.request === undefined ? {} : { wrapperRequest: built.request }),
  };
}

export function describeLaunchPlan(
  plan: LaunchPlan,
  prompt?: ResolvedPrompt,
): string {
  const parts = [
    plan.kind,
    `type=${plan.agentType}`,
    `agent=${plan.agentId}`,
    `session=${plan.sessionId}`,
    `delivery=${plan.promptDelivery}`,
    `capability=${plan.writeCapability}`,
    `lease=${plan.requiresWriteLease ? "required" : "not-required"}`,
  ];
  if (prompt !== undefined) parts.push(describeResolvedPrompt(prompt));
  return parts.join(" ");
}
