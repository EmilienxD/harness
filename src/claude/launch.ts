/**
 * Claude Code launch planning (spec sections 4.3, 5.1-5.4, 5.7, 5.8, 8.3).
 *
 * A launch plan is a pure value: argv, a shell-quoted command line, an optional
 * prompt spill file, and the derived write capability. Nothing here touches the
 * filesystem, VS Code, or a process, so every launch shape is snapshot-testable.
 *
 * Two invariants shape the whole module:
 *
 * - `--agent` and `--tools`/`--system-prompt` are mutually exclusive (5.1.1).
 *   A plan that mixes them is rejected, never silently reconciled.
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

export const DEFAULT_CLAUDE_EXECUTABLE = "claude";
export const DEFAULT_RUNTIME_DIRECTORY = ".aboard/runtime";
/** `aboard.launch.maxInlinePromptChars` — conservative, below every known ceiling. */
export const DEFAULT_MAX_INLINE_PROMPT_CHARS = 4000;

export const MANAGER_TOOL_PRESETS = ["read-only", "delegation-only"] as const;

export type ManagerToolPreset = (typeof MANAGER_TOOL_PRESETS)[number];

/**
 * Spec section 4.3. `Agent` and the session-task tools are absent from both
 * presets rather than denied: the Manager cannot reach for a tool it cannot
 * see, and we do not pay context for a schema it must never use.
 */
export const MANAGER_TOOL_PRESET_TOOLS: Readonly<
  Record<ManagerToolPreset, readonly string[]>
> = {
  "read-only": ["aboard__*", "Read", "Grep", "Glob", "Bash", "Skill", "AskUserQuestion"],
  "delegation-only": ["aboard__*", "Skill", "AskUserQuestion"],
};

/** `aboard.workers.permissionMode` (spec section 8.3). */
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
      readonly shape: "inline";
      readonly tools?: readonly string[];
      readonly systemPrompt?: string;
    };

/** The flat shape a caller supplies, so the exclusive pair can be rejected. */
export interface LaunchConfigurationInput {
  readonly agentName?: string | undefined;
  readonly declaredTools?: readonly string[] | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly systemPrompt?: string | undefined;
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
  | "unrepresentable-system-prompt"
  | "invalid-threshold"
  | "invalid-sequence"
  | "missing-prompt"
  | "missing-message"
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
 * Rejects the `--agent` plus `--tools`/`--system-prompt` combination that looks
 * like composition but is not (spec section 5.1.1).
 */
export function resolveLaunchConfiguration(
  input: LaunchConfigurationInput,
): LaunchConfiguration {
  if (input.agentName !== undefined) {
    if (input.tools !== undefined || input.systemPrompt !== undefined) {
      throw new LaunchPlanError(
        "conflicting-launch-shape",
        "--agent cannot be combined with --tools or --system-prompt",
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
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
  };
}

/**
 * Capability is derived from the effective tool set, never declared. `raw` is
 * the one type fixed by the spec rather than by derivation: it has no
 * definition to read and is exactly where ad-hoc edits happen, so it is
 * write-capable whatever tools the user configured (sections 5.7 and 9.7).
 */
export function launchWriteCapability(
  agentType: AgentType,
  configuration: LaunchConfiguration,
): WriteCapability {
  if (agentType === "raw") return "write-capable";
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
  readonly executable: string;
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
  readonly executable?: string | undefined;
  readonly maxInlinePromptChars?: number | undefined;
  readonly runtimeDirectory?: string | undefined;
}

export interface LaunchPlanRequest extends CommonPlanRequest {
  readonly configuration: LaunchConfiguration;
  /** Required for automated types, optional for interactive ones (5.3, 5.4). */
  readonly prompt?: ResolvedPrompt | string | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
}

export interface ResumePlanRequest extends CommonPlanRequest {
  readonly message: ResolvedPrompt | string;
  /**
   * Capability of the session being resumed. It was derived when the session
   * was created; resume carries no shape flags that could change it.
   */
  readonly writeCapability: WriteCapability;
  /** 1-based ordinal of this resume, so a spill never overwrites an earlier one. */
  readonly sequence: number;
}

export type ManagerResumePlanRequest = Omit<CommonPlanRequest, "agentType" | "permissionMode">;

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

function toolListArguments(
  flag: string,
  rules: readonly string[] | undefined,
): readonly string[] {
  if (rules === undefined || rules.length === 0) return [];
  return [flag, ...rules.map((rule) => assertFlagValue(rule, "invalid-tool-rule", "tool rule"))];
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
  readonly executable: string;
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
  return {
    executable: request.executable ?? DEFAULT_CLAUDE_EXECUTABLE,
    threshold,
    runtimeDirectory: request.runtimeDirectory ?? DEFAULT_RUNTIME_DIRECTORY,
  };
}

export function planLaunch(request: LaunchPlanRequest): LaunchPlan {
  const { executable, threshold, runtimeDirectory } = commonPreconditions(request);
  const { agentType, configuration } = request;

  if (agentType === "manager" && configuration.shape !== "inline") {
    throw new LaunchPlanError(
      "shape-not-allowed",
      "The Manager is the top-level session and never launches with --agent",
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
  } else {
    shapeArguments.push(...toolListArguments("--tools", configuration.tools));
    if (configuration.systemPrompt !== undefined) {
      const systemPrompt = configuration.systemPrompt.trim();
      if (!canQuoteArgument(request.shell, systemPrompt)) {
        throw new LaunchPlanError(
          "unrepresentable-system-prompt",
          `System prompt cannot be passed on a ${request.shell} command line`,
        );
      }
      shapeArguments.push("--system-prompt", systemPrompt);
    }
  }

  const promptPlan = planPrompt(prompt, {
    agentId: request.agentId,
    shell: request.shell,
    threshold,
    runtimeDirectory,
    stem: request.agentId,
  });

  const args = [
    "--session-id",
    request.sessionId,
    ...shapeArguments,
    ...toolListArguments("--disallowedTools", request.disallowedTools),
    ...(request.model === undefined
      ? []
      : ["--model", assertFlagValue(request.model, "invalid-model", "model")]),
    ...permissionArguments(request.permissionMode),
    ...promptPlan.args,
  ];

  const capability = launchWriteCapability(agentType, configuration);
  return {
    kind: "start",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType,
    shell: request.shell,
    executable,
    args,
    commandLine: buildCommandLine(request.shell, executable, args),
    writeCapability: capability,
    requiresWriteLease: requiresWriteLease(agentType, capability),
    promptDelivery: promptPlan.delivery,
    ...(promptPlan.spill === undefined ? {} : { spill: promptPlan.spill }),
  };
}

/**
 * `aboard__send_to_agent` and Manager resume (6.2, 4.4): relaunch with
 * `--resume <session-id> <message>`. Never keystrokes into a live TUI.
 *
 * Resume carries no `--agent`/`--tools`, matching the spec's resume command and
 * keeping the mutually exclusive pair out of a second code path. Permission
 * mode is re-passed because `bypassPermissions` is documented as never carried
 * over by `--resume` (`docs/CLAUDE-REFERENCES/hooks.md`).
 */
export function planResume(request: ResumePlanRequest): LaunchPlan {
  const { executable, threshold, runtimeDirectory } = commonPreconditions(request);

  const message = normalizePrompt(request.message);
  if (message === undefined) {
    throw new LaunchPlanError("missing-message", "A resume must carry a non-empty message");
  }
  if (!Number.isInteger(request.sequence) || request.sequence < 1) {
    throw new LaunchPlanError("invalid-sequence", "Resume sequence must be a positive integer");
  }

  const promptPlan = planPrompt(message, {
    agentId: request.agentId,
    shell: request.shell,
    threshold,
    runtimeDirectory,
    // Earlier spill files are retained for the session lifetime so `--resume`
    // can still resolve their references, so each message gets its own file.
    stem: `${request.agentId}-resume-${request.sequence}`,
  });

  const args = [
    "--resume",
    request.sessionId,
    ...(request.model === undefined
      ? []
      : ["--model", assertFlagValue(request.model, "invalid-model", "model")]),
    ...permissionArguments(request.permissionMode),
    ...promptPlan.args,
  ];

  return {
    kind: "resume",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType: request.agentType,
    shell: request.shell,
    executable,
    args,
    commandLine: buildCommandLine(request.shell, executable, args),
    writeCapability: request.writeCapability,
    requiresWriteLease: requiresWriteLease(request.agentType, request.writeCapability),
    promptDelivery: promptPlan.delivery,
    ...(promptPlan.spill === undefined ? {} : { spill: promptPlan.spill }),
  };
}

/** The long-lived Manager resumes without an automated message (spec 4.4). */
export function planManagerResume(request: ManagerResumePlanRequest): LaunchPlan {
  const { executable } = commonPreconditions({
    ...request,
    agentType: "manager",
    permissionMode: "default",
  });
  const args = ["--resume", request.sessionId];
  return {
    kind: "resume",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType: "manager",
    shell: request.shell,
    executable,
    args,
    commandLine: buildCommandLine(request.shell, executable, args),
    writeCapability: "read-only",
    requiresWriteLease: false,
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
