
import type { WriteCapability } from "../domain/capability.js";
import {
  isAutomatedAgentType,
  isNamedBuiltinAgentType,
  type AgentId,
  type AgentType,
  type SessionId,
} from "../domain/contracts.js";

import type { IssueDifficulty } from "../shared/labels.js";
import {
  describeResolvedPrompt,
  normalizeGeneratedPrompt,
  resolvedPromptFromText,
  type ResolvedPrompt,
} from "./prompts.js";
import { buildCommandLine, canQuoteArgument, type ShellKind } from "./shell.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_CLAUDE_COMMAND = ["claude"] as const;
/** Planner-only fallback; production supplies VS Code's workspace storage root. */
export const DEFAULT_RUNTIME_DIRECTORY = join(tmpdir(), "abd-runtime");
/** `aboard.launch.maxInlinePromptChars`; conservative, below every known ceiling. */
export const DEFAULT_MAX_INLINE_PROMPT_CHARS = 4000;

export const MAX_COMMAND_LINE_CHARS: Readonly<Record<ShellKind, number>> = {
  cmd: 8_000,
  powershell: 24_000,
  "git-bash": 24_000,
};


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
  /** What the command line carries; the declaration, or the session default behind it. */
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
      readonly shape: "builtin";
      readonly agentName: string;
      readonly declaredModel?: string;
      readonly declaredEffort?: DeclaredEffort;
      readonly declaredCommand?: readonly string[];
    }
  | {
      /** A normal top-level Claude session whose first prompt invokes a Harness skill. */
      readonly shape: "skill";
      readonly skillName: string;
      readonly declaredModel?: string;
      readonly declaredEffort?: DeclaredEffort;
      readonly declaredCommand?: readonly string[];
    }
  /** Claude Code's unmodified default interactive session. */
  | { readonly shape: "default" };

export type AutoRunReviewMode = "afk" | "hitl";
export type AutoRunWorkerType = "implementer" | "reviewer";

export const AUTO_RUN_WORKER_SKILLS = {
  implementer: "implement",
  reviewer: "review-afk",
} as const;

export function autoRunWorkerConfiguration(
  type: AutoRunWorkerType,
  reviewMode: AutoRunReviewMode = "afk",
): LaunchConfiguration {
  return {
    shape: "skill",
    skillName: type === "reviewer" ? `review-${reviewMode}` : AUTO_RUN_WORKER_SKILLS[type],
    declaredModel: BY_DIFFICULTY,
    declaredEffort: BY_DIFFICULTY,
  };
}

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

    if (
      input.systemPrompt !== undefined ||
      input.declaredTools !== undefined ||
      input.declaredDescription !== undefined ||
      input.extraFrontmatter !== undefined
    ) {
      throw new LaunchPlanError(
        "shape-not-allowed",
        "Generated custom agent definitions are no longer supported",
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
  if (configuration.shape === "skill") return "write-capable";
  return configuration.shape === "default" ? "write-capable" : "read-only";
}

export function requiresWriteLease(
  agentType: AgentType,
  capability: WriteCapability,
): boolean {
  return capability === "write-capable";
}

/** A file the plan needs on disk before its command line can run. */
export interface RuntimeFile {
  readonly agentId: AgentId;
  /** Absolute path, with POSIX separators in generated plans. */
  readonly relativePath: string;
  readonly contents: string;
}

/** The path is the exact text after `@`, so it carries no whitespace. */
export type PromptSpillFile = RuntimeFile;


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
  /** Original worker task, preserved independently of resume messages. */
  readonly task?: PromptSpillFile;

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

  /** Set only for an auto-run implementer whose frozen issue has `[AI]-chrome`. */
  readonly chrome?: true | undefined;
  readonly maxInlinePromptChars?: number | undefined;
  /** Absolute root in VS Code's workspace storage. */
  readonly runtimeDirectory?: string | undefined;
  readonly wrapper?: SessionWrapperLayout | undefined;
}

export interface SessionWrapperLayout {
  /** Absolute path of the scaffolded wrapper script. */
  readonly script: string;
  /** Per-agent marker path the wrapper owns (`lockFile` in the request). */
  lockPathFor(agentId: AgentId): string;
  /** Fresh capability embedded in exactly one wrapper request path. */
  mintLaunchCode(): string;
}

export interface LaunchPlanRequest extends CommonPlanRequest {
  readonly configuration: LaunchConfiguration;
  /** Required for automated types, optional for interactive ones (5.3, 5.4). */
  readonly prompt?: ResolvedPrompt | string | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
}


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
  return resolved.text.trim().length === 0 ? undefined : normalizeGeneratedPrompt(resolved);
}

/** Namespace temp prompts by workspace storage so cleanup cannot affect another project. */
export function promptSpillRoot(runtimeDirectory: string): string {
  const identity = createHash("sha256").update(resolve(runtimeDirectory)).digest("hex");
  return join(tmpdir(), "abd-prompts", identity);
}

export function taskPromptPath(runtimeDirectory: string, agentId: AgentId): string {
  const path = `${promptSpillRoot(runtimeDirectory).replaceAll("\\", "/")}/${agentId}/task.md`;
  if (/\s/.test(path)) throw new LaunchPlanError("unsafe-spill-path", `Prompt spill path must not contain whitespace: ${path}`);
  return path;
}

function spillRelativePath(runtimeDirectory: string, agentId: AgentId, stem: string): string {
  const directory = promptSpillRoot(runtimeDirectory).replaceAll("\\", "/");
  const path = `${directory}/${agentId}/${stem}-${randomUUID()}.md`;
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
    readonly invocation?: string;
  },
): PromptPlan {
  if (prompt === undefined) return { delivery: "none", args: [] };

  const text = prompt.text.trim();
  const inline = options.invocation === undefined ? text : `${options.invocation} ${text}`;
  if (inline.length <= options.threshold && canQuoteArgument(options.shell, inline)) {
    return { delivery: "inline", args: [inline] };
  }

  const relativePath = spillRelativePath(options.runtimeDirectory, options.agentId, options.stem);
  const reference = `Your full task is in @${relativePath}; follow it.`;
  const prefix = options.invocation === undefined ? "" : `${options.invocation} `;
  const withHeadline = `${prefix}${prompt.headline} ${reference}`;
  const stub =
    withHeadline.length <= options.threshold && canQuoteArgument(options.shell, withHeadline)
      ? withHeadline
      : `${prefix}${reference}`;

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
  readonly launchCode: string | undefined;
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
  const launchCode = wrapper?.mintLaunchCode();
  if (wrapper !== undefined) {
    for (const token of [wrapper.script, wrapper.lockPathFor(request.agentId)]) {
      if (token.trim().length === 0 || !canQuoteArgument(request.shell, token)) {
        throw new LaunchPlanError(
          "invalid-command",
          `Wrapper token cannot be passed on a ${request.shell} command line: ${JSON.stringify(token)}`,
        );
      }
    }
    if (launchCode === undefined || !AGENT_ID_PATTERN.test(launchCode)) {
      throw new LaunchPlanError(
        "invalid-command",
        `Wrapper launch code is not safe as a file name: ${JSON.stringify(launchCode)}`,
      );
    }
  }
  return {
    command,
    threshold,
    runtimeDirectory: request.runtimeDirectory ?? DEFAULT_RUNTIME_DIRECTORY,
    wrapper,
    launchCode,
  };
}

function wrapperRequestFile(
  runtimeDirectory: string,
  agentId: AgentId,
  launchCode: string,
  command: readonly string[],
  args: readonly string[],
): WrapperRequestFile {
  return {
    agentId,
    relativePath: `${agentRuntimeDirectory(runtimeDirectory, agentId)}/launch-${launchCode}.json`,
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
  launchCode: string | undefined,
): { readonly command: readonly string[]; readonly args: readonly string[]; readonly request?: WrapperRequestFile } {
  if (wrapper === undefined) return { command, args };
  if (launchCode === undefined) throw new LaunchPlanError("invalid-command", "Wrapper launch code is missing");
  const request = wrapperRequestFile(runtimeDirectory, agentId, launchCode, command, args);
  return {
    command: ["uv", "run", "--no-project", "--no-managed-python", wrapper.script],
    args: [wrapper.lockPathFor(agentId), "--request", request.relativePath],
    request,
  };
}

function assertLaunchShape(agentType: AgentType, configuration: LaunchConfiguration): void {
  if (agentType === "interactive") {
    if (configuration.shape !== "default") {
      throw new LaunchPlanError("shape-not-allowed", "interactive launches as Claude Code's default session");
    }
    return;
  }
  if (agentType === "implementer") {
    if (configuration.shape !== "skill" || configuration.skillName !== "implement") {
      throw new LaunchPlanError("shape-not-allowed", "implementer must launch through /implement");
    }
    return;
  }
  if (agentType === "reviewer") {
    if (configuration.shape !== "skill" || !["review-afk", "review-hitl"].includes(configuration.skillName)) {
      throw new LaunchPlanError("shape-not-allowed", "reviewer must launch through /review-afk or /review-hitl");
    }
    return;
  }
  if (isNamedBuiltinAgentType(agentType) && configuration.shape === "builtin" && configuration.agentName === agentType) return;
  throw new LaunchPlanError("shape-not-allowed", `${agentType} has no supported launch configuration`);
}

export function planLaunch(request: LaunchPlanRequest): LaunchPlan {
  const { command, threshold, runtimeDirectory, wrapper, launchCode } = commonPreconditions(request, request.configuration);
  const { agentType, configuration } = request;

  assertLaunchShape(agentType, configuration);

  const prompt = normalizePrompt(request.prompt);
  if (prompt === undefined && (isAutomatedAgentType(agentType) || configuration.shape === "skill")) {
    // An automated worker with no first message sits at an empty TUI forever.
    // Harness-backed workers also need a first message to invoke their skill;
    // attended workers may be interactive after that initial expansion.
    throw new LaunchPlanError(
      "missing-prompt",
      `${agentType} cannot launch without its initial prompt`,
    );
  }

  const launchRuntimeDirectory = agentRuntimeDirectory(runtimeDirectory, request.agentId);
  const task = prompt !== undefined && (agentType === "implementer" || agentType === "reviewer")
    ? { agentId: request.agentId, relativePath: taskPromptPath(runtimeDirectory, request.agentId), contents: `${prompt.text.trim()}\n` }
    : undefined;
  const shapeArguments: string[] = [
    "--add-dir", launchRuntimeDirectory,
    "--settings", `${launchRuntimeDirectory}/settings.json`,
  ];
  const policy = launchPolicy(configuration.shape === "default" ? {} : configuration, request);

  switch (configuration.shape) {
    case "builtin":
      shapeArguments.push("--agent", configuration.agentName);
      break;
    case "skill":
      break;
    case "default":
      break;
  }

  const fixedArguments = [
    "--session-id",
    request.sessionId,
    ...shapeArguments,

    ...toolListArguments("--disallowedTools", denyRules(request.disallowedTools)),
    ...modelArguments(policy.model),
    ...effortArguments(policy.effort),
    ...chromeArguments(agentType, request.chrome),
  ];

  const planFor = (promptThreshold: number): { readonly plan: PromptPlan; readonly args: string[]; readonly commandLine: string; readonly request?: WrapperRequestFile } => {
    const plan = planPrompt(prompt, {
      agentId: request.agentId,
      shell: request.shell,
      threshold: promptThreshold,
      runtimeDirectory,
      stem: "prompt",
      ...(configuration.shape === "skill" ? { invocation: `/${configuration.skillName}` } : {}),
    });
    const args = [...fixedArguments, ...plan.args];
    const wrapped = wrapCommand(command, args, wrapper, request.agentId, runtimeDirectory, launchCode);
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
    ...(task === undefined ? {} : { task }),

    ...(built.request === undefined ? {} : { wrapperRequest: built.request }),
  };
}


export function planSessionResume(request: SessionResumePlanRequest): LaunchPlan {
  const { command, wrapper, runtimeDirectory, launchCode, threshold } = commonPreconditions(request, request.configuration);
  const { configuration } = request;
  assertLaunchShape(request.agentType, configuration);
  const policy = launchPolicy(configuration.shape === "default" ? {} : configuration, request);

  const launchRuntimeDirectory = agentRuntimeDirectory(runtimeDirectory, request.agentId);
  // Claude Code restores a builtin's `--agent` selection with the conversation.
  const shapeArguments = [
    "--add-dir", launchRuntimeDirectory,
    "--settings", `${launchRuntimeDirectory}/settings.json`,
  ];
  const fixedArguments = [
    "--resume",
    request.sessionId,
    ...shapeArguments,

    ...toolListArguments("--disallowedTools", denyRules(request.disallowedTools)),
    ...modelArguments(policy.model),
    ...effortArguments(policy.effort),
    ...chromeArguments(request.agentType, request.chrome),
  ];
  const prompt = normalizePrompt(request.prompt);
  const planFor = (promptThreshold: number): { readonly promptPlan: PromptPlan; readonly args: string[]; readonly commandLine: string; readonly request?: WrapperRequestFile } => {
    const promptPlan = planPrompt(prompt, {
      agentId: request.agentId,
      shell: request.shell,
      threshold: promptThreshold,
      runtimeDirectory,
      stem: "continue",
    });
    const args = [...fixedArguments, ...promptPlan.args];
    const wrapped = wrapCommand(command, args, wrapper, request.agentId, runtimeDirectory, launchCode);
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
