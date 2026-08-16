/**
 * Claude Code launch planning (spec sections 4.3, 5.1-5.4, 5.7, 5.8, 8.3).
 *
 * A launch plan is a pure value: argv, a shell-quoted command line, an optional
 * prompt spill file, and the derived write capability. Nothing here touches the
 * filesystem, VS Code, or a process, so every launch shape is snapshot-testable.
 *
 * Two invariants shape the whole module:
 *
 * - An agent's tool set lives in the `tools:` field of its
 *   `.aboard/agents/<name>.md` definition, and every flag that carries it comes
 *   from that one file (5.1.1). aboard's own agents are not registered as
 *   Claude Code subagents at all: a definition under `.claude/agents/` is
 *   discovered by *every* session in the workspace, including a user's own
 *   `claude`, which then sees `implementer` and the pr-doctors as spawnable
 *   types — outside the bridge and outside the write lease. So the definition
 *   lives where nothing discovers it, and the launch carries its body as
 *   `--system-prompt-file` and its tools as `--tools`. One file, two flags, no
 *   second authority: nothing can widen an agent past what it declares, which
 *   is what the write-lease derivation depends on.
 *
 *   `--agent` therefore survives only for Claude Code's named `Explore` type.
 *   Its metadata-only aboard profile may select the command, model, and effort,
 *   but its system prompt and tool set belong to Claude Code, so aboard neither
 *   reconstructs them nor adds a competing `--tools` flag.
 * - The first message and every later message travel as CLI arguments (5.1.2,
 *   5.1.3). aboard never types into a running TUI, so a message that cannot be
 *   represented on a command line spills to a file and is `@`-referenced.
 */

import { deriveWriteCapability, type WriteCapability } from "../domain/capability.js";
import {
  isAutomatedAgentType,
  isNamedBuiltinAgentType,
  isInteractiveAgentType,
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

/** The scaffolded definition the Manager session runs from. */
export const MANAGER_AGENT_NAME = "manager";

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
 * permission prompt — so bypass is the value unattended launches get. A launch
 * the user drives or is handed gets no flag at all, so the user's own Claude
 * Code configuration decides; see `resolvePermissionMode`.
 */
export const WORKER_PERMISSION_MODES = ["bypass", "acceptEdits", "default"] as const;

export type WorkerPermissionMode = (typeof WORKER_PERMISSION_MODES)[number];

/**
 * Adjusts the configured permission mode for a specific launch (spec section
 * 8.3). The setting exists so unattended `afk` work never deadlocks on a
 * permission prompt in a terminal nobody is watching; a launch the user drives
 * or is handed lives under their eye, so bypass there would strip the
 * checkpoint they are the point of.
 *
 * - `attended` launches — the Manager itself, `pr-doctor-hitl`, and every
 *   interactive handoff — keep a human in the loop by construction. aboard puts
 *   no permission flag on their command line at all (`"default"` emits none):
 *   substituting a mode of its own would override the user's own Claude Code
 *   configuration, which is exactly what the setting must not do there.
 * - `brainstormer` is pinned to `default` regardless: its whole contract is a
 *   conversation with a present user (its definition says so), and a user who
 *   set bypass for afk work never meant their brainstorm terminal to stop
 *   asking entirely.
 * - Unattended launches keep the mode unchanged: bypass is exactly what they
 *   are for, and degrading one would recreate the silent deadlock an unattended permission prompt causes.
 */
export function resolvePermissionMode(
  mode: WorkerPermissionMode,
  launch: { readonly attended: boolean; readonly agentType: AgentType },
): WorkerPermissionMode {
  if (launch.agentType === "brainstormer") return "default";
  if (mode === "bypass" && launch.attended) return "default";
  return mode;
}

/**
 * `aboard.launch.effort` — the session-wide reasoning effort, the `--effort`
 * levels `claude --help` documents. It is the session floor rather than the last
 * word: an agent definition's `effort:` frontmatter overrides it, and the
 * planner puts that value on the command line itself, because a main-thread
 * `--agent` launch does not honor the field (see `LaunchConfiguration`). The
 * setting is what reaches launches whose definition or builtin profile declines
 * to choose its own level.
 *
 * Unset means "inherit", exactly as an absent `effort:` field does; aboard
 * passes no flag and Claude Code keeps whatever the user's own `effortLevel`
 * setting says.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVEL_SET.has(value);
}

export type LaunchConfiguration =
  /**
   * An aboard agent definition (`.aboard/agents/<name>.md`), carried onto the
   * command line in full: the body as `--system-prompt-file` and `tools:` as
   * `--tools`. The file is not under `.claude/agents/`, so no session in the
   * workspace can discover the agent or spawn it — see the module header.
   */
  | {
      readonly shape: "agent-defined";
      readonly agentName: string;
      /** The definition body, written to the runtime file the launch points at. */
      readonly systemPrompt: string;
      /** `tools:` read from the same definition. Never empty. */
      readonly declaredTools: readonly string[];
      /**
       * `model:` and `effort:` read from the same definition, carried onto the
       * command line because no flag short of these two applies them.
       *
       * Claude Code applies the *full* frontmatter only when an agent is spawned
       * as a subagent; a main-thread launch honors a smaller subset, and one
       * launched from a system-prompt file has no frontmatter to read at all. So
       * aboard reads both fields itself and passes `--model`/`--effort`
       * explicitly. `inherit` is normalized away at resolve time, because
       * "inherit" is the frontmatter spelling of "pass no flag".
       */
      readonly declaredModel?: string;
      readonly declaredEffort?: EffortLevel;
      /**
       * `command:` read from the same definition, in the same token form as
       * `aboard.launch.claudeCommand`. It replaces the configured launch command
       * for this agent alone, so one agent can run through a wrapper — a
       * provider switcher such as `clauder run kiro --` — while the rest of the
       * fleet keeps the configured default. Absent means "use the setting",
       * which is the only reason it is optional rather than resolved here: the
       * setting is read per launch, and baking it in would freeze it.
       */
      readonly declaredCommand?: readonly string[];
    }
  /**
   * Claude Code's named `Explore` builtin. Its aboard profile carries launch
   * policy only; `--agent` still selects Claude's prompt and tools, and aboard
   * deliberately passes neither a system-prompt flag nor `--tools`.
   */
  | {
      readonly shape: "builtin";
      readonly agentName: string;
      readonly declaredModel?: string;
      readonly declaredEffort?: EffortLevel;
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
  readonly declaredModel?: string | undefined;
  readonly declaredEffort?: EffortLevel | undefined;
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
 * Rejects the `--agent` plus `--tools` combination: a named builtin's prompt and
 * tool set remain Claude Code's. aboard may layer only launch policy (command,
 * model, effort) over that opaque definition.
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
    // Normalize the launch-policy fields for both complete definitions and
    // metadata-only builtin profiles. `inherit` and an empty command both mean
    // the fleet-wide setting remains in charge.
    const declaredModel =
      input.declaredModel === undefined || input.declaredModel === "inherit"
        ? undefined
        : assertFlagValue(input.declaredModel, "invalid-model", "agent model");
    if (input.declaredEffort !== undefined && !isEffortLevel(input.declaredEffort)) {
      throw new LaunchPlanError(
        "invalid-effort",
        `Agent effort must be one of ${EFFORT_LEVELS.join(", ")}: ${JSON.stringify(input.declaredEffort)}`,
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
      return {
        shape: "builtin",
        agentName: input.agentName,
        ...(declaredModel === undefined ? {} : { declaredModel }),
        ...(input.declaredEffort === undefined ? {} : { declaredEffort: input.declaredEffort }),
        ...(declaredCommand === undefined ? {} : { declaredCommand }),
      };
    }

    // The name becomes a file name under the runtime directory, so it must be a
    // single path segment. A plugin-scoped name (`plugin:agent`) is a legal
    // `--agent` value but can never name an aboard definition.
    if (!AGENT_ID_PATTERN.test(input.agentName)) {
      throw new LaunchPlanError(
        "invalid-agent-name",
        `An aboard agent definition name must be a single path segment: ${input.agentName}`,
      );
    }
    if (input.systemPrompt.trim().length === 0) {
      // An empty file is the one failure Claude Code does not report: it starts
      // the session on its own default persona, which for a definition-launched
      // agent means full default behavior under a tool list it never chose.
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
    return {
      shape: "agent-defined",
      agentName: input.agentName,
      systemPrompt: input.systemPrompt,
      declaredTools: input.declaredTools,
      ...(declaredModel === undefined ? {} : { declaredModel }),
      ...(input.declaredEffort === undefined ? {} : { declaredEffort: input.declaredEffort }),
      ...(declaredCommand === undefined ? {} : { declaredCommand }),
    };
  }

  if (
    input.systemPrompt !== undefined ||
    input.declaredTools !== undefined ||
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

/**
 * Capability is derived from an aboard definition's effective tool set, never
 * declared separately. Builtin capabilities are fixed by Claude Code itself:
 * Explore is read-only and general-purpose has the full tool set. aboard has no
 * definition file from which either could be derived
 * (`docs/CLAUDE-REFERENCES/subagents.md`).
 */
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

/**
 * The Manager is launched, not delegated, and it is long-lived: a permanent
 * lease holder would deadlock every worker. Its residual `Bash` write vector is
 * addressed by `--disallowedTools` (section 4.3.1), not by the lease.
 */
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

/**
 * The definition body, written where `--system-prompt-file` points. It is
 * derived data under the gitignored runtime directory rather than the
 * definition itself, because the file the flag reads must hold the body alone:
 * pointing at `.aboard/agents/<name>.md` would put its YAML frontmatter into
 * the agent's system prompt.
 */
export type SystemPromptFile = RuntimeFile;

export type PromptDelivery = "none" | "inline" | "spilled";

export interface LaunchPlan {
  readonly kind: "start" | "resume";
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly shell: ShellKind;
  /**
   * The launch command tokens actually used, program first: the definition's
   * `command:` where it declares one, `aboard.launch.claudeCommand` otherwise.
   * Preflight probes this rather than the setting, so a per-agent override is
   * verified as the command that will really run.
   */
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly writeCapability: WriteCapability;
  readonly requiresWriteLease: boolean;
  readonly promptDelivery: PromptDelivery;
  readonly spill?: PromptSpillFile;
  /**
   * Present for every agent-defined launch *and resume*: unlike `--agent`, a
   * system prompt passed by flag is not restored by `--resume`, so the file has
   * to exist again each time the command line is run.
   */
  readonly systemPrompt?: SystemPromptFile;
}

interface CommonPlanRequest {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly shell: ShellKind;
  readonly permissionMode: WorkerPermissionMode;
  /**
   * Whether the launch lives under the user's eye — the Manager itself, a
   * type that can only ever be handed over, or an explicit interactive handoff.
   * Unattended launches (automated workers left to run) are the case bypass
   * exists for; see `resolvePermissionMode`. It also gates
   * `--disable-slash-commands` (see `slashCommandArguments`): an unattended
   * launch's first message is the only one it will ever get and nobody is
   * watching to catch a hijack, while an attended terminal is exactly where the
   * user types real slash commands. Absent means "derive from the type", which
   * the launch sites that know better override.
   */
  readonly attended?: boolean | undefined;
  readonly model?: string | undefined;
  readonly effort?: EffortLevel | undefined;
  readonly command?: readonly string[] | undefined;
  readonly maxInlinePromptChars?: number | undefined;
  readonly runtimeDirectory?: string | undefined;
  /**
   * When set, the command line launches `uv run --no-project <script> <lockFile> -- <original line>`:
   * aboard's wrapper owns a marker file for exactly the child's lifetime, and
   * the bridge polls that file for liveness instead of scraping process ids.
   */
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
  readonly disallowedTools?: readonly string[] | undefined;
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

/**
 * A leading `-` normally means the value was mistaken for a flag and would be
 * parsed as one. A launch command's tokens are the exception: `--` is how a
 * wrapper separates its own arguments from Claude Code's (`clauder run kiro --`),
 * so there the check is emptiness alone.
 */
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

/**
 * `claude --help` documents tool lists as comma-separated values ("Bash,Edit,
 * Read"), and the flags are variadic. Variadic means the option consumes every
 * following argument until the next one starting with `-`, so `--tools a,b`
 * followed by the positional prompt swallows the prompt as another tool name —
 * verified against Claude Code 2.1.229, which then refuses the launch with
 * "Input must be provided either through stdin or as a prompt argument".
 *
 * Keep the option and its value as separate arguments. Claude Code's documented
 * form is `--tools "Bash,Edit,Read"`; the shell quoting layer will quote the
 * value as needed when it builds the command line.
 */
function toolListArguments(
  flag: string,
  rules: readonly string[] | undefined,
): readonly string[] {
  if (rules === undefined || rules.length === 0) return [];
  const list = rules.map((rule) => assertFlagValue(rule, "invalid-tool-rule", "tool rule")).join(",");
  return [flag, list];
}

/**
 * Effort is a closed set rather than free text like `--model`, whose value may
 * be a full model id. The check is kept even though the type says the same
 * thing: the value arrives from a settings file, where a typo is a user's
 * mistake rather than a compile error, and an unknown level would make Claude
 * Code refuse the whole launch.
 */
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

/**
 * An unattended launch's first message is attacker-reachable text — an issue
 * body, a PR diff, a roadmap subject — delivered as the only message the
 * session will ever get, with no human present to notice a hijack. Claude
 * Code parses that message for slash commands before aboard's prompt is "just
 * text" to it, so a prompt that happens to open with `/clear` or the name of
 * any project skill fires that command instead of being read as a task.
 * `--disable-slash-commands` turns the parser off for the whole session,
 * which is exactly what an unattended launch needs and an attended one must
 * never get: the user types real slash commands into those terminals
 * (`/compact`, `/auto`, aboard's own skills), and disabling the parser would
 * silently break that.
 */
function slashCommandArguments(attended: boolean): readonly string[] {
  return attended ? [] : ["--disable-slash-commands"];
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

/**
 * Unlike a spill reference this is an ordinary argument rather than `@path`
 * text, so the shell quoting handles whitespace and only the separators need
 * normalizing.
 */
function systemPromptRelativePath(runtimeDirectory: string, agentName: string): string {
  const directory = runtimeDirectory.replaceAll("\\", "/").replace(/\/+$/, "");
  return `${directory}/agents/${agentName}.md`;
}

/**
 * The flags that carry an aboard definition, and the file one of them reads.
 * Emitted identically by `planLaunch` and by both resume planners: a resumed
 * session keeps neither the system prompt nor the tool restriction, so leaving
 * them off a resume would silently reopen a read-only agent with the full
 * default tool set (verified against Claude Code 2.1.229).
 */
function definitionArguments(
  configuration: Extract<LaunchConfiguration, { shape: "agent-defined" }>,
  agentId: AgentId,
  runtimeDirectory: string,
): { readonly args: readonly string[]; readonly file: SystemPromptFile } {
  const relativePath = systemPromptRelativePath(runtimeDirectory, configuration.agentName);
  return {
    args: [
      "--system-prompt-file",
      relativePath,
      ...toolListArguments("--tools", configuration.declaredTools),
    ],
    file: { agentId, relativePath, contents: `${configuration.systemPrompt.trim()}\n` },
  };
}

/**
 * Deny rules come from one place — `aboard.manager.disallowedTools` — and are
 * deduplicated, since the same rule twice says nothing more than once. An agent
 * definition declares no denials of its own: its `tools:` allowlist is the whole
 * tool authority (spec section 5.1.1), and there is no longer a project-scoped
 * MCP server whose tools an allowlist could fail to exclude.
 */
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

/**
 * The command tokens this launch actually runs. A definition's `command:` wins
 * over `aboard.launch.claudeCommand`, for the same reason its `model:` and
 * `effort:` do: it is the agent's own declaration, and the setting is the
 * fleet-wide default for the launches that declare nothing. `--resume` reads no
 * definition, so a resumed session gets the override re-applied here exactly as
 * it gets `--system-prompt-file` and `--tools` re-passed.
 */
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
  readonly permissionMode: WorkerPermissionMode;
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
  // A wrapper's own arguments reach argv, so they are checked here rather than
  // trusted from a setting or an agent definition: an empty token would launch
  // the wrong program, and an unquotable one would be silently mangled into the
  // command line.
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
  // The caller knows who will be driving; when it says nothing, the type
  // answers: the Manager always works with the user watching, and the
  // interactive types exist solely to be handed over.
  const attended =
    request.attended ?? (request.agentType === "manager" || isInteractiveAgentType(request.agentType));
  return {
    command,
    threshold,
    runtimeDirectory: request.runtimeDirectory ?? DEFAULT_RUNTIME_DIRECTORY,
    wrapper,
    permissionMode: resolvePermissionMode(request.permissionMode, { attended, agentType: request.agentType }),
    attended,
  };
}

/** The wrapper executable, then the marker path and the original line after `--`. */
function wrapCommand(
  command: readonly string[],
  args: readonly string[],
  wrapper: SessionWrapperLayout | undefined,
  agentId: AgentId,
): { readonly command: readonly string[]; readonly args: readonly string[] } {
  if (wrapper === undefined) return { command, args };
  return {
    command: ["uv", "run", "--no-project", "--no-managed-python", wrapper.script],
    args: [wrapper.lockPathFor(agentId), "--", ...command, ...args],
  };
}

export function planLaunch(request: LaunchPlanRequest): LaunchPlan {
  const { command, threshold, runtimeDirectory, wrapper, permissionMode, attended } = commonPreconditions(request, request.configuration);
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
    // `--agent` names Claude Code's own definitions and nothing else: aboard
    // ships no file a builtin name could resolve to, and its own agents are
    // deliberately undiscoverable, so neither can borrow the other's shape.
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

  const shapeArguments: string[] = [];
  let systemPrompt: SystemPromptFile | undefined;
  switch (configuration.shape) {
    case "agent-defined": {
      const definition = definitionArguments(configuration, request.agentId, runtimeDirectory);
      shapeArguments.push(...definition.args);
      systemPrompt = definition.file;
      break;
    }
    case "builtin":
      shapeArguments.push("--agent", configuration.agentName);
      break;
    case "default":
      break;
  }

  // A complete definition or builtin profile wins over the session settings.
  // Explore's profile affects only these launch flags; its prompt and tools
  // still come exclusively from Claude Code through `--agent`.
  const declared =
    configuration.shape !== "default"
      ? configuration
      : { declaredModel: undefined, declaredEffort: undefined };

  const fixedArguments = [
    "--session-id",
    request.sessionId,
    ...shapeArguments,
    ...toolListArguments("--disallowedTools", denyRules(request.disallowedTools)),
    ...modelArguments(declared.declaredModel ?? request.model),
    ...effortArguments(declared.declaredEffort ?? request.effort),
    ...permissionArguments(permissionMode),
    ...slashCommandArguments(attended),
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
    const wrapped = wrapCommand(command, args, wrapper, request.agentId);
    return { plan, args, commandLine: buildCommandLine(request.shell, wrapped.command, wrapped.args) };
  };

  // The prompt threshold alone cannot decide this. It measures the prompt text,
  // while the shell's limit applies to the whole assembled line — which also
  // carries the wrapper command, any tool-list flags, and quoting that expands
  // rather than preserves length (PowerShell doubles every `'`, Git Bash turns
  // one into four characters). A prompt comfortably under the threshold can
  // still produce a command line that the shell truncates or refuses, so the
  // line itself is measured and the prompt spilled if it is too long. Spilling
  // is always safe, so an unsure implementation spills.
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
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

/**
 * Manager resume (spec 4.4): relaunch with `--resume <session-id>`. Never
 * keystrokes into a live TUI. The long-lived Manager resumes without an
 * automated message.
 *
 * Every flag that shaped the original launch is passed again. `--resume`
 * restores the conversation and nothing else: permission mode is documented as
 * never carried over (`docs/CLAUDE-REFERENCES/hooks.md`), and a session started
 * from `--system-prompt-file`/`--tools` comes back with Claude Code's default
 * persona and its *full* default tool set unless both flags are repeated. For
 * the Manager that would mean resuming an orchestrator that can implement.
 */
export function planManagerResume(request: ManagerResumePlanRequest): LaunchPlan {
  const { command, wrapper, runtimeDirectory, permissionMode, attended } = commonPreconditions({ ...request, agentType: "manager" }, request.configuration);
  if (
    request.configuration.shape !== "agent-defined" ||
    request.configuration.agentName !== MANAGER_AGENT_NAME
  ) {
    throw new LaunchPlanError(
      "shape-not-allowed",
      "The Manager resumes from .aboard/agents/manager.md",
    );
  }
  const definition = definitionArguments(request.configuration, request.agentId, runtimeDirectory);
  const args = [
    "--resume",
    request.sessionId,
    ...definition.args,
    ...toolListArguments("--disallowedTools", denyRules(request.disallowedTools)),
    ...modelArguments(request.configuration.declaredModel ?? request.model),
    ...effortArguments(request.configuration.declaredEffort ?? request.effort),
    ...permissionArguments(permissionMode),
    ...slashCommandArguments(attended),
  ];
  const wrapped = wrapCommand(command, args, wrapper, request.agentId);
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
    systemPrompt: definition.file,
  };
}

/**
 * Reopens a worker's recorded session (`AGENTS.md`),
 * re-passing the same flags as the Manager's resume and for the same reason:
 * `--resume` restores the conversation, not the configuration. A read-only
 * worker resumed without `--tools` comes back holding `Edit`, `Write`, and an
 * unrestricted `Bash`, which the lease it was granted at launch does not cover.
 *
 * Capability is therefore derived here from the configuration rather than
 * accepted from the caller: it must describe the session this command line
 * actually produces.
 */
export function planSessionResume(request: SessionResumePlanRequest): LaunchPlan {
  const { command, wrapper, runtimeDirectory, permissionMode, attended } = commonPreconditions(request, request.configuration);
  const { configuration } = request;
  const definition = configuration.shape === "agent-defined"
    ? definitionArguments(configuration, request.agentId, runtimeDirectory)
    : undefined;
  // Claude Code restores a builtin's `--agent` selection with the conversation.
  const shapeArguments = definition?.args ?? [];
  const declared = configuration.shape !== "default"
    ? configuration
    : { declaredModel: undefined, declaredEffort: undefined };
  const args = [
    "--resume",
    request.sessionId,
    ...shapeArguments,
    ...toolListArguments("--disallowedTools", denyRules(request.disallowedTools)),
    ...modelArguments(declared.declaredModel ?? request.model),
    ...effortArguments(declared.declaredEffort ?? request.effort),
    ...permissionArguments(permissionMode),
    ...slashCommandArguments(attended),
  ];
  const wrapped = wrapCommand(command, args, wrapper, request.agentId);
  const capability = launchWriteCapability(request.agentType, configuration);
  return {
    kind: "resume",
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType: request.agentType,
    shell: request.shell,
    command,
    args,
    commandLine: buildCommandLine(request.shell, wrapped.command, wrapped.args),
    writeCapability: capability,
    requiresWriteLease: requiresWriteLease(request.agentType, capability),
    promptDelivery: "none",
    ...(definition === undefined ? {} : { systemPrompt: definition.file }),
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
