/**
 * Claude Code launch planning (spec sections 4.3, 5.1-5.4, 5.7, 5.8, 8.3).
 *
 * A launch plan is a pure value: argv, a shell-quoted command line, an optional
 * prompt spill file, and the derived write capability. Nothing here touches the
 * filesystem, VS Code, or a process, so every launch shape is snapshot-testable.
 *
 * Two invariants shape the whole module:
 *
 * - For an agent whose definition declares `tools:`, `--agent` and
 *   `--tools` are mutually exclusive (5.1.1). A plan that
 *   mixes them is rejected, never silently reconciled. The Manager is the sole
 *   exception, and only because its definition declares no `tools:` at all: an
 *   agent that omits the field inherits the full pool, so `--tools <preset>`
 *   narrows it rather than competing with it. That keeps the tool set a runtime
 *   setting (4.3) while the persona lives in `.claude/agents/manager.md`.
 * - The first message and every later message travel as CLI arguments (5.1.2,
 *   5.1.3). aboard never types into a running TUI, so a message that cannot be
 *   represented on a command line spills to a file and is `@`-referenced.
 */

import { deriveWriteCapability, type WriteCapability } from "../domain/capability.js";
import {
  isAutomatedAgentType,
  type AgentId,
  type AgentType,
  type SessionId,
} from "../domain/contracts.js";
import {
  describeResolvedPrompt,
  resolvedPromptFromText,
  type ResolvedPrompt,
} from "./prompts.js";
import { buildCommandLine, canQuoteArgument, type ShellKind } from "./shell.js";

/**
 * `aboard.launch.claudeCommand`. The launch command is a token list rather than
 * a single executable so a wrapper can carry its own fixed arguments — a
 * profile switcher launches as `clauder run kiro --`, where everything after
 * `--` is Claude Code's. aboard appends its flags to these tokens and changes
 * nothing else about how they are passed.
 */
export const DEFAULT_CLAUDE_COMMAND = ["claude"] as const;
export const DEFAULT_RUNTIME_DIRECTORY = ".aboard/runtime";
/** `aboard.launch.maxInlinePromptChars` — conservative, below every known ceiling. */
export const DEFAULT_MAX_INLINE_PROMPT_CHARS = 4000;

/**
 * The longest command line each shell will carry, as a whole line rather than
 * per argument.
 *
 * - `cmd.exe` hard-fails past 8191 characters, and there is no escape from it.
 * - PowerShell and Git Bash are bounded instead by `CreateProcess`, whose
 *   `lpCommandLine` caps at 32767 for the process the shell ultimately spawns.
 *
 * Both figures are taken well below the documented ceiling because the line is
 * delivered as terminal input, where a console's own line-editing buffer can
 * truncate before the shell ever parses it — and a truncated launch command is
 * far worse than a spilled prompt, because it fails silently or launches
 * something subtly different from what was planned.
 */
export const MAX_COMMAND_LINE_CHARS: Readonly<Record<ShellKind, number>> = {
  cmd: 8_000,
  powershell: 24_000,
  "git-bash": 24_000,
};

/** The scaffolded definition the Manager session runs as (`--agent manager`). */
export const MANAGER_AGENT_NAME = "manager";

export const MANAGER_TOOL_PRESETS = ["read-only", "delegation-only"] as const;

export type ManagerToolPreset = (typeof MANAGER_TOOL_PRESETS)[number];

/**
 * Spec section 4.3. `Agent` and the session-task tools are absent from both
 * presets rather than denied: the Manager cannot reach for a tool it cannot
 * see, and we do not pay context for a schema it must never use.
 *
 * MCP tools are named `mcp__<server>__<tool>` inside Claude Code, so the
 * bridge's tool surface (`mcp__aboard__run_agent`, …) is matched by the
 * server-wide pattern `mcp__aboard__*`.
 */
export const MANAGER_TOOL_PRESET_TOOLS: Readonly<
  Record<ManagerToolPreset, readonly string[]>
> = {
  "read-only": ["mcp__aboard__*", "Read", "Grep", "Glob", "Bash", "Skill", "AskUserQuestion"],
  "delegation-only": ["mcp__aboard__*", "Skill", "AskUserQuestion"],
};

export type ClaudeCommandResult =
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the launch command setting, accepting either a token array or a command
 * string. The string form is split on whitespace with `'...'` and `"..."`
 * grouping a token that contains spaces, which is what lets a quoted program
 * path coexist with a wrapper's arguments (`"C:\\tools\\my claude.exe" run --`).
 *
 * This is deliberately not a shell parser: the result is a program plus its
 * arguments, each quoted individually at build time, so `&&`, `|`, and `>` are
 * literal argument text rather than operators.
 */
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

/**
 * `aboard.workers.permissionMode` (spec section 8.3). The setting is named for
 * the case it exists to serve — an unattended `afk` worker deadlocks on a
 * permission prompt — but it is a property of how aboard launches Claude Code,
 * not of one agent type. It applies to every session aboard starts or resumes,
 * the Manager included: a Manager that stops on a prompt the user chose to
 * bypass everywhere else is the same surprise, in the one terminal that is
 * supposed to keep the fleet moving.
 */
export const WORKER_PERMISSION_MODES = ["bypass", "acceptEdits", "default"] as const;

export type WorkerPermissionMode = (typeof WORKER_PERMISSION_MODES)[number];

export type LaunchConfiguration =
  | {
      readonly shape: "agent-defined";
      readonly agentName: string;
      /** `tools:` read from `.claude/agents/<name>.md`; absent when unreadable. */
      readonly declaredTools?: readonly string[];
    }
  | {
      /**
       * Manager only: `--agent manager --tools <preset>`. Valid because the
       * Manager definition declares no `tools:`, so nothing is overridden.
       */
      readonly shape: "agent-preset";
      readonly agentName: string;
      readonly tools: readonly string[];
    }
  /**
   * The raw agent of spec section 5.7, which is the *absence* of an agent
   * definition. It carries no `--system-prompt`: raw is defined as unconstrained
   * (section 9.7), so there is no prompt to pass, and nothing in the extension
   * has ever produced one. The spec's shape table listed the flag as optional;
   * supporting an option no caller can reach only added an unbounded argument to
   * every command line the planner has to fit inside a shell's limit.
   */
  | {
      readonly shape: "inline";
      readonly tools?: readonly string[];
    };

/** The flat shape a caller supplies, so the exclusive pair can be rejected. */
export interface LaunchConfigurationInput {
  readonly agentName?: string | undefined;
  readonly declaredTools?: readonly string[] | undefined;
  readonly tools?: readonly string[] | undefined;
}

export type LaunchPlanErrorCode =
  | "conflicting-launch-shape"
  | "declared-tools-without-agent"
  | "invalid-agent-name"
  | "invalid-tool-rule"
  | "invalid-model"
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

/**
 * Rejects the `--agent` plus `--tools` combination that looks like composition
 * but is not (spec section 5.1.1).
 */
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
    return {
      shape: "agent-defined",
      agentName: input.agentName,
      ...(input.declaredTools === undefined ? {} : { declaredTools: input.declaredTools }),
    };
  }

  if (input.declaredTools !== undefined) {
    throw new LaunchPlanError(
      "declared-tools-without-agent",
      "declaredTools describe an agent definition and require agentName",
    );
  }
  return {
    shape: "inline",
    ...(input.tools === undefined ? {} : { tools: input.tools }),
  };
}

/**
 * The one configuration that pairs `--agent` with `--tools`. It is built here
 * rather than through `resolveLaunchConfiguration` so the exclusive pair stays
 * rejected everywhere a caller could reach it with an arbitrary agent name.
 */
export function managerLaunchConfiguration(preset: ManagerToolPreset): LaunchConfiguration {
  return {
    shape: "agent-preset",
    agentName: MANAGER_AGENT_NAME,
    tools: MANAGER_TOOL_PRESET_TOOLS[preset],
  };
}

/**
 * Capability is derived from the effective tool set, never declared. Two types
 * are fixed rather than derived. `raw` is fixed by the spec: it has no
 * definition to read and is exactly where ad-hoc edits happen, so it is
 * write-capable whatever tools the user configured (sections 5.7 and 9.7).
 * `Explore` is fixed by Claude Code itself: its builtin definition is a
 * read-only search agent, and aboard scaffolds no file that could be read to
 * derive that (`docs/CLAUDE-REFERENCES/subagents.md`).
 */
export function launchWriteCapability(
  agentType: AgentType,
  configuration: LaunchConfiguration,
): WriteCapability {
  if (agentType === "raw") return "write-capable";
  if (agentType === "Explore") return "read-only";
  // `agent-preset` and `inline` both carry the effective list in `tools`.
  return deriveWriteCapability(
    configuration.shape === "agent-defined" ? configuration.declaredTools : configuration.tools,
  );
}

/**
 * The Manager is launched, not delegated, and it is long-lived: a permanent
 * lease holder would deadlock every worker. Its residual `Bash` write vector in
 * the `read-only` preset is addressed by `--disallowedTools` (section 4.3.1),
 * not by the lease.
 */
export function requiresWriteLease(
  agentType: AgentType,
  capability: WriteCapability,
): boolean {
  return agentType !== "manager" && capability === "write-capable";
}

export interface PromptSpillFile {
  readonly agentId: AgentId;
  /** Workspace-relative, POSIX separators, the exact text after `@`. */
  readonly relativePath: string;
  readonly contents: string;
}

export type PromptDelivery = "none" | "inline" | "spilled";

export interface LaunchPlan {
  readonly kind: "start" | "resume";
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly shell: ShellKind;
  /** The launch command tokens (`aboard.launch.claudeCommand`), program first. */
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly writeCapability: WriteCapability;
  readonly requiresWriteLease: boolean;
  readonly promptDelivery: PromptDelivery;
  readonly spill?: PromptSpillFile;
}

interface CommonPlanRequest {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly shell: ShellKind;
  readonly permissionMode: WorkerPermissionMode;
  readonly model?: string | undefined;
  readonly command?: readonly string[] | undefined;
  readonly maxInlinePromptChars?: number | undefined;
  readonly runtimeDirectory?: string | undefined;
}

export interface LaunchPlanRequest extends CommonPlanRequest {
  readonly configuration: LaunchConfiguration;
  /** Required for automated types, optional for interactive ones (5.3, 5.4). */
  readonly prompt?: ResolvedPrompt | string | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
}

export type ManagerResumePlanRequest = Omit<CommonPlanRequest, "agentType">;

export interface SessionResumePlanRequest extends CommonPlanRequest {
  readonly writeCapability: WriteCapability;
}

/**
 * aboard never writes a `permissions` block into project settings (4.3.1);
 * permission mode is a per-process launch flag and nothing else.
 */
function permissionArguments(mode: WorkerPermissionMode): readonly string[] {
  switch (mode) {
    case "bypass":
      return ["--dangerously-skip-permissions"];
    case "acceptEdits":
      return ["--permission-mode", "acceptEdits"];
    case "default":
      return [];
  }
}

function assertFlagValue(
  value: string,
  code: LaunchPlanErrorCode,
  description: string,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) {
    throw new LaunchPlanError(code, `Invalid ${description}: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/**
 * `claude --help` documents tool lists as comma-separated values in a single
 * argument ("Bash,Edit,Read"). They must not be spread as separate arguments:
 * the flags are variadic, so trailing values would swallow the positional
 * launch prompt.
 */
function toolListArguments(
  flag: string,
  rules: readonly string[] | undefined,
): readonly string[] {
  if (rules === undefined || rules.length === 0) return [];
  return [flag, rules.map((rule) => assertFlagValue(rule, "invalid-tool-rule", "tool rule")).join(",")];
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

function commonPreconditions(request: CommonPlanRequest): {
  readonly command: readonly string[];
  readonly threshold: number;
  readonly runtimeDirectory: string;
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
  const command = request.command === undefined || request.command.length === 0
    ? [...DEFAULT_CLAUDE_COMMAND]
    : request.command;
  // A wrapper's own arguments reach argv, so they are checked here rather than
  // trusted from a setting: an empty token would launch the wrong program, and
  // an unquotable one would be silently mangled into the command line.
  for (const token of command) {
    if (token.trim().length === 0 || !canQuoteArgument(request.shell, token)) {
      throw new LaunchPlanError(
        "invalid-command",
        `Launch command token cannot be passed on a ${request.shell} command line: ${JSON.stringify(token)}`,
      );
    }
  }
  return {
    command,
    threshold,
    runtimeDirectory: request.runtimeDirectory ?? DEFAULT_RUNTIME_DIRECTORY,
  };
}

export function planLaunch(request: LaunchPlanRequest): LaunchPlan {
  const { command, threshold, runtimeDirectory } = commonPreconditions(request);
  const { agentType, configuration } = request;

  if (agentType === "manager" && configuration.shape !== "agent-preset") {
    throw new LaunchPlanError(
      "shape-not-allowed",
      "The Manager launches as --agent manager with a tool preset",
    );
  }
  if (agentType !== "manager" && configuration.shape === "agent-preset") {
    // Only the Manager has a definition without `tools:`; for every other agent
    // this shape would widen or contradict the frontmatter the lease trusts.
    throw new LaunchPlanError(
      "shape-not-allowed",
      "Only the Manager combines --agent with a --tools preset",
    );
  }
  if (agentType === "raw" && configuration.shape !== "inline") {
    throw new LaunchPlanError(
      "shape-not-allowed",
      "raw is the absence of an agent definition and never launches with --agent",
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

  const shapeArguments: string[] = [];
  if (configuration.shape === "agent-defined") {
    shapeArguments.push("--agent", configuration.agentName);
  } else if (configuration.shape === "agent-preset") {
    shapeArguments.push("--agent", configuration.agentName);
    shapeArguments.push(...toolListArguments("--tools", configuration.tools));
  } else {
    shapeArguments.push(...toolListArguments("--tools", configuration.tools));
  }

  const fixedArguments = [
    "--session-id",
    request.sessionId,
    ...shapeArguments,
    ...toolListArguments("--disallowedTools", request.disallowedTools),
    ...(request.model === undefined
      ? []
      : ["--model", assertFlagValue(request.model, "invalid-model", "model")]),
    ...permissionArguments(request.permissionMode),
  ];

  const planFor = (promptThreshold: number): { readonly plan: PromptPlan; readonly args: string[]; readonly commandLine: string } => {
    const plan = planPrompt(prompt, {
      agentId: request.agentId,
      shell: request.shell,
      threshold: promptThreshold,
      runtimeDirectory,
      stem: request.agentId,
    });
    const args = [...fixedArguments, ...plan.args];
    return { plan, args, commandLine: buildCommandLine(request.shell, command, args) };
  };

  // The prompt threshold alone cannot decide this. It measures the prompt text,
  // while the shell's limit applies to the whole assembled line — which also
  // carries the wrapper command, the tool lists, a system prompt, and quoting
  // that expands rather than preserves length (PowerShell doubles every `'`,
  // Git Bash turns one into four characters). A prompt comfortably under the
  // threshold can still produce a command line that the shell truncates or
  // refuses, so the line itself is measured and the prompt spilled if it is too
  // long. Spilling is always safe, so an unsure implementation spills.
  const limit = MAX_COMMAND_LINE_CHARS[request.shell];
  let built = planFor(threshold);
  if (built.commandLine.length > limit && built.plan.delivery === "inline") built = planFor(0);
  if (built.commandLine.length > limit) {
    throw new LaunchPlanError(
      "command-line-too-long",
      `Launch command line is ${built.commandLine.length} characters, over the ${limit} the ${request.shell} shell accepts, even with the prompt spilled to a file. Shorten the agent's tool list.`,
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
    ...(promptPlan.spill === undefined ? {} : { spill: promptPlan.spill }),
  };
}

/**
 * Manager resume (spec 4.4): relaunch with `--resume <session-id>`. Never
 * keystrokes into a live TUI. The long-lived Manager resumes without an
 * automated message.
 *
 * Resume carries no `--agent`/`--tools`, matching the spec's resume command and
 * keeping the mutually exclusive pair out of a second code path. Permission
 * mode is re-passed because `bypassPermissions` is documented as never carried
 * over by `--resume` (`docs/CLAUDE-REFERENCES/hooks.md`).
 */
export function planManagerResume(request: ManagerResumePlanRequest): LaunchPlan {
  const { command } = commonPreconditions({ ...request, agentType: "manager" });
  const args = ["--resume", request.sessionId, ...permissionArguments(request.permissionMode)];
  return {
    kind: "resume",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType: "manager",
    shell: request.shell,
    command,
    args,
    commandLine: buildCommandLine(request.shell, command, args),
    writeCapability: "read-only",
    requiresWriteLease: false,
    promptDelivery: "none",
  };
}

/**
 * Reopens a worker's recorded session (`docs/auto-implementation.md` §9). Like
 * the Manager's resume it carries no `--agent`/`--tools`: the session already
 * has its configuration, and re-passing it would put the mutually exclusive pair
 * into a second code path. Permission mode is re-passed because
 * `bypassPermissions` is documented as never carried over by `--resume`.
 */
export function planSessionResume(request: SessionResumePlanRequest): LaunchPlan {
  const { command } = commonPreconditions(request);
  const args = ["--resume", request.sessionId, ...permissionArguments(request.permissionMode)];
  return {
    kind: "resume",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType: request.agentType,
    shell: request.shell,
    command,
    args,
    commandLine: buildCommandLine(request.shell, command, args),
    writeCapability: request.writeCapability,
    requiresWriteLease: requiresWriteLease(request.agentType, request.writeCapability),
    promptDelivery: "none",
  };
}

/**
 * A redacted, loggable description. The command line is deliberately excluded:
 * it contains the prompt whenever the prompt is inline.
 */
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
