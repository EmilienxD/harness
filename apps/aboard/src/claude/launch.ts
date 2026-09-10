
import type { WriteCapability } from "../domain/capability.js";
import {
  isAutomatedAgentType,
  isAutoRunWorkerType,
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

interface LaunchConfigurationBase {
  readonly declaredModel?: string;
  readonly declaredEffort?: DeclaredEffort;
  readonly declaredCommand?: readonly string[];
  readonly deniedTools?: readonly string[];
}

export type LaunchConfiguration =
  | (LaunchConfigurationBase & {
      readonly shape: "builtin";
      readonly agentName: string;
    })
  | (LaunchConfigurationBase & {
      /** A normal top-level Claude session whose first prompt invokes a Harness skill. */
      readonly shape: "skill";
      readonly skillName: string;
    })
  /** Claude Code's unmodified default interactive session. */
  | (LaunchConfigurationBase & { readonly shape: "default" });

export type LaunchPlanErrorCode =
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

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  return isAutoRunWorkerType(agentType) && capability === "write-capable";
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
  /** The launch needs the platform's Chrome browser capability before it may start. */
  readonly chromeRequired?: true;
  /** Worker restrictions a platform enforces through its own lifecycle hook. */
  readonly guard?: RuntimeFile;
  /** Native permission profile required before this launch may create a terminal. */
  readonly permissionProfile?: string;

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
  /** True only when Aboard's Auto Run owns and controls this session. */
  readonly autoRunRestricted?: true | undefined;
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
  /** Additional native sandbox roots required by a provider-specific worker. */
  readonly writableRoots?: readonly string[] | undefined;
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
  if (configuration.declaredCommand !== undefined) {
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
  if (["interactive", "Prototype", "Web Search", "Brainstorm", "General"].includes(agentType)) {
    if (configuration.shape !== "default") {
      throw new LaunchPlanError("shape-not-allowed", "interactive launches as Claude Code's default session");
    }
    return;
  }
  if (agentType === "implementer") {
    if (configuration.shape !== "skill" || configuration.skillName !== "address-issue") {
      throw new LaunchPlanError("shape-not-allowed", "implementer must launch through /address-issue");
    }
    return;
  }
  if (agentType === "reviewer") {
    // One skill for both dispositions: AFK and HITL differ in orchestration.
    if (configuration.shape !== "skill" || configuration.skillName !== "review-issue") {
      throw new LaunchPlanError("shape-not-allowed", "reviewer must launch through /review-issue");
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

    ...toolListArguments("--disallowedTools", denyRules([
      ...(configuration.deniedTools ?? []),
      ...(request.disallowedTools ?? []),
    ])),
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

    ...toolListArguments("--disallowedTools", denyRules([
      ...(configuration.deniedTools ?? []),
      ...(request.disallowedTools ?? []),
    ])),
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
