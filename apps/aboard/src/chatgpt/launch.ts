import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { WriteCapability } from "../domain/capability.js";
import { isAutoRunWorkerType, isHeadlessExecution, type AgentId, type AgentType, type SessionId } from "../domain/contracts.js";
import { buildCommandLine, canQuoteArgument, type ShellKind } from "../platform/shell.js";
import { promptFileReference, skillInvocation } from "../platform/prompts.js";
import { normalizeFileReferences } from "../platform/prompt-paths.js";
import { BY_DIFFICULTY, MAX_COMMAND_LINE_CHARS, promptSpillRoot, requiresWriteLease, taskPromptPath, type LaunchPlan, LaunchPlanError, type PromptDelivery, type RuntimeFile, type SessionWrapperLayout } from "../platform/launch.js";
import type { PlatformLaunchPlan, PlatformLaunchRequest, PlatformResumeRequest } from "../platform/agent-platform.js";
import type { IssueDifficulty } from "../shared/labels.js";
import { codexHookConfigArguments } from "./hooks.js";

export const DEFAULT_CHATGPT_COMMAND = ["codex"] as const;

export const CHATGPT_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ChatGptEffort = (typeof CHATGPT_EFFORTS)[number];

export const CHATGPT_WEB_SEARCH_MODES = ["disabled", "cached", "indexed", "live"] as const;
export type ChatGptWebSearch = (typeof CHATGPT_WEB_SEARCH_MODES)[number];

export const CHATGPT_WORKER_SKILLS = ["address-this", "review-this"] as const;

export interface ChatGptDifficultyLaunchPolicy {
  readonly model: string;
  readonly effort: ChatGptEffort;
}

/** ChatGPT routing, configurable on its own so Claude model names never reach Codex. */
export const CHATGPT_DIFFICULTY_LAUNCH_POLICIES: { readonly [K in IssueDifficulty]: ChatGptDifficultyLaunchPolicy } = {
  routine: { model: "gpt-5.6-luna", effort: "medium" },
  basic: { model: "gpt-5.6-terra", effort: "high" },
  advanced: { model: "gpt-5.6-sol", effort: "medium" },
  expert: { model: "gpt-5.6-sol", effort: "high" },
};

export function chatGptDifficultyLaunchPolicy(difficulty: IssueDifficulty | undefined): ChatGptDifficultyLaunchPolicy {
  return CHATGPT_DIFFICULTY_LAUNCH_POLICIES[difficulty ?? "expert"];
}

export interface ChatGptLaunchConfiguration {
  readonly shape: "default" | "explore" | "skill";
  readonly skillName?: string;
  readonly declaredCommand?: readonly string[];
  readonly declaredModel?: string;
  readonly declaredEffort?: ChatGptEffort | typeof BY_DIFFICULTY;
  readonly webSearch?: ChatGptWebSearch;
  readonly subagents?: "allowed" | "denied";
}

const READ_ONLY_POLICY = ["--sandbox", "read-only", "-c", 'approval_policy="never"'] as const;

const CLAUDE_MODELS: ReadonlySet<string> = new Set(["haiku", "sonnet", "opus"]);
const WORKTREE_PERMISSION_PROFILE = "aboard-worktree";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function planChatGptLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan {
  return planChatGptSession(request, "start");
}

export function planChatGptSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan {
  return planChatGptSession(request, "resume");
}

function planChatGptSession(request: PlatformLaunchRequest | PlatformResumeRequest, kind: "start" | "resume"): PlatformLaunchPlan {
  const configuration = request.configuration as ChatGptLaunchConfiguration;
  const explore = request.agentType === "explore";
  const worker = isAutoRunWorkerType(request.agentType);
  const autoRunRestricted = request.autoRunRestricted === true;
  assertShape(request.agentType, configuration);
  if (!SAFE_ID.test(request.agentId)) throw new LaunchPlanError("unsafe-agent-id", `Agent id is not safe as a file name: ${request.agentId}`);
  if (!UUID.test(request.sessionId)) throw new LaunchPlanError("invalid-session-id", kind === "start" ? "Provisional session id must be a UUID minted before launch" : "Saved session id must be a UUID");
  const command = configuration.declaredCommand ?? request.command ?? DEFAULT_CHATGPT_COMMAND;
  if (command.length === 0 || command.some((token) => token.trim().length === 0 || !canQuoteArgument(request.shell, token))) {
    throw new LaunchPlanError("invalid-command", `Launch command cannot be passed on a ${request.shell} command line`);
  }
  const threshold = request.maxInlinePromptChars ?? 4000;
  if (!Number.isInteger(threshold) || threshold < 0) throw new LaunchPlanError("invalid-threshold", "maxInlinePromptChars must be a non-negative integer");
  const chrome = request.chrome === true;
  if (chrome && !worker) throw new LaunchPlanError("shape-not-allowed", `The Chrome browser backend is available only to [AI]-chrome auto-run workers: ${request.agentType}`);
  const requestedRuntimeRoot = request.runtimeDirectory ?? join(tmpdir(), "abd-runtime");
  const runtimeRoot = isAbsolute(requestedRuntimeRoot) || /^[A-Za-z]:[\\/]/u.test(requestedRuntimeRoot)
    ? requestedRuntimeRoot
    : resolve(requestedRuntimeRoot);
  const runtimeDirectory = `${runtimeRoot.replaceAll("\\", "/").replace(/\/+$/u, "")}/agents/${request.agentId}`;
  const hookScript = `${runtimeRoot.replaceAll("\\", "/").replace(/\/+$/u, "")}/scripts/abd_hook.py`;
  const subagentsDenied = request.restrictions?.denySubagents === true || configuration.subagents === "denied";
  const denyCommands = [...new Set(request.restrictions?.deniedCommands ?? [])];
  const readOnlyFiles = [...new Set(request.restrictions?.protectedPaths ?? [])];
  const guard: RuntimeFile | undefined = autoRunRestricted
    ? {
        agentId: request.agentId,
        relativePath: `${runtimeDirectory}/guard.json`,
        contents: `${JSON.stringify({ denySubagents: subagentsDenied, denyCommands }, null, 2)}\n`,
      }
    : undefined;
  const policy = launchPolicy(configuration, request.difficulty, request.modelOverride);
  const permissionProfile = readOnlyFiles.length === 0
    ? []
    : permissionProfileArguments(readOnlyFiles, explore, worker ? request.writableRoots ?? [] : []);
  const fixed = [
    "--dangerously-bypass-hook-trust",
    "--add-dir", runtimeRoot,
    "-c", "features.hooks=true",
    ...(explore && readOnlyFiles.length === 0 ? READ_ONLY_POLICY : []),
    ...permissionProfile,
    ...(request.restrictions?.denyWeb === true
      ? ["-c", 'web_search="disabled"']
      : configuration.webSearch === undefined ? [] : ["-c", `web_search=${JSON.stringify(configuration.webSearch)}`]),
    ...(subagentsDenied ? ["-c", "features.multi_agent=false", "-c", "agents.enabled=false"] : []),
    ...codexHookConfigArguments(hookScript, request.agentType, guard !== undefined),
    ...(policy.model === undefined ? [] : ["--model", policy.model]),
    ...(policy.effort === undefined ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(policy.effort)}`]),
  ];
  const task = typeof request.prompt === "string" ? request.prompt : request.prompt?.text;
  if (explore && (task === undefined || task.length === 0)) throw new LaunchPlanError("missing-prompt", "explore cannot launch without its exploration task");
  if (worker && kind === "start" && (task === undefined || task.length === 0)) throw new LaunchPlanError("missing-prompt", `${request.agentType} cannot launch without its initial prompt`);
  const text = task === undefined || task.trim().length === 0 ? undefined : normalizeFileReferences(task, request.cwd);
  // Only a launch owns the frozen task; a resume message must not replace the
  // archive that regrounds the worker after compaction.
  const archived: RuntimeFile | undefined = worker && kind === "start" && text !== undefined
    ? { agentId: request.agentId, relativePath: taskPromptPath(runtimeRoot, request.agentId, request.promptRoot), contents: text }
    : undefined;
  // A resume continues the conversation the skill already governs.
  const invocation = kind !== "start"
    ? undefined
    : configuration.shape === "skill"
      ? skillInvocation("$", configuration.skillName ?? "")
      : request.skill === undefined ? undefined : skillInvocation("$", request.skill);
  const planFor = (promptThreshold: number): { readonly promptDelivery: PromptDelivery; readonly spill?: RuntimeFile; readonly args: readonly string[]; readonly commandLine: string; readonly wrapperRequest?: RuntimeFile } => {
    let promptDelivery: PromptDelivery = "none";
    let spill: RuntimeFile | undefined;
    let promptArgs: string[] = [];
    if (text !== undefined && text.length > 0) {
      const inline = invocation === undefined ? text : `${invocation} ${text}`;
      if (inline.length <= promptThreshold && canQuoteArgument(request.shell, inline)) {
        promptDelivery = "inline";
        promptArgs = ["--", inline];
      } else {
        promptDelivery = "spilled";
        const relativePath = archived?.relativePath
          ?? `${join(promptSpillRoot(runtimeRoot, request.promptRoot), request.agentId, "prompt.md").replaceAll("\\", "/")}`;
        if (/\s/u.test(relativePath)) throw new LaunchPlanError("unsafe-spill-path", `Prompt spill path must not contain whitespace: ${relativePath}`);
        spill = { agentId: request.agentId, relativePath, contents: text };
        const reference = normalizeFileReferences(promptFileReference(relativePath), request.cwd);
        promptArgs = ["--", invocation === undefined ? reference : `${invocation} ${reference}`];
      }
    }
    const background = isHeadlessExecution(request.agentType, request.executionMode);
    const conversation = request.forkSessionId === undefined
      ? kind === "resume" ? ["resume", request.sessionId] : []
      : ["fork", request.forkSessionId];
    const args = [...(background ? ["exec", "--json"] : []), ...fixed, ...conversation, ...promptArgs];
    const wrapped = wrap(command, args, request.wrapper, request.agentId, request.sessionId, runtimeRoot);
    return {
      promptDelivery,
      args,
      commandLine: buildCommandLine(request.shell, wrapped.command, wrapped.args),
      ...(spill === undefined ? {} : { spill }),
      ...(wrapped.request === undefined ? {} : { wrapperRequest: wrapped.request }),
    };
  };
  const limit = MAX_COMMAND_LINE_CHARS[request.shell];
  let built = planFor(threshold);
  if (built.commandLine.length > limit && built.promptDelivery === "inline") built = planFor(0);
  if (built.commandLine.length > limit) throw new LaunchPlanError("command-line-too-long", `ChatGPT launch command line is ${built.commandLine.length} characters, over the ${limit} the ${request.shell} shell accepts, even with the prompt spilled to a file`);
  const writeCapability: WriteCapability = explore ? "read-only" : "write-capable";
  return {
    platform: "chatgpt",
    kind,
    agentId: request.agentId,
    sessionId: request.sessionId,
    agentType: request.agentType,
    shell: request.shell,
    command,
    args: built.args,
    commandLine: built.commandLine,
    writeCapability,
    requiresWriteLease: requiresWriteLease(request.agentType, writeCapability),
    promptDelivery: built.promptDelivery,
    runtimeDirectory,
    providerEnvironment: {
      ...(guard === undefined ? {} : { ABOARD_GUARD_PATH: guard.relativePath }),
      ...(isHeadlessExecution(request.agentType, request.executionMode) ? { ABOARD_HEADLESS_CHATGPT: "1" } : {}),
    },
    ...(chrome ? { chromeRequired: true as const } : {}),
    ...(guard === undefined ? {} : { guard }),
    ...(readOnlyFiles.length === 0 ? {} : { permissionProfile: WORKTREE_PERMISSION_PROFILE }),
    ...(archived === undefined ? {} : { task: archived }),
    ...(built.spill === undefined ? {} : { spill: built.spill }),
    ...(built.wrapperRequest === undefined ? {} : { wrapperRequest: built.wrapperRequest }),
  };
}

function assertShape(agentType: AgentType, configuration: ChatGptLaunchConfiguration): void {
  switch (agentType) {
    case "interactive":
    case "prototype":
    case "websearch":
    case "brainstorm":
    case "general":
      if (configuration.shape !== "default") throw new LaunchPlanError("shape-not-allowed", "interactive launches as Codex's default session");
      return;
    case "explore":
      if (configuration.shape !== "explore") throw new LaunchPlanError("shape-not-allowed", "explore launches as a read-only Codex session");
      return;
    case "address":
      if (configuration.shape !== "skill" || configuration.skillName !== "address-this") {
        throw new LaunchPlanError("shape-not-allowed", "address must launch through $address-this");
      }
      return;
    case "review":
      // One skill for both dispositions: AFK and HITL differ in orchestration.
      if (configuration.shape !== "skill" || configuration.skillName !== "review-this") {
        throw new LaunchPlanError("shape-not-allowed", "review must launch through $review-this");
      }
      return;
  }
}

function launchPolicy(
  configuration: ChatGptLaunchConfiguration,
  difficulty: IssueDifficulty | undefined,
  modelOverride: string | undefined,
): { readonly model: string | undefined; readonly effort: ChatGptEffort | undefined } {
  const tier = chatGptDifficultyLaunchPolicy(difficulty);
  const model = modelOverride ?? (configuration.declaredModel === BY_DIFFICULTY ? tier.model : configuration.declaredModel);
  const effort = configuration.declaredEffort === BY_DIFFICULTY ? tier.effort : configuration.declaredEffort;
  if (model !== undefined && (model.trim().length === 0 || CLAUDE_MODELS.has(model))) {
    throw new LaunchPlanError("invalid-model", `Model is not valid for platform chatgpt: ${JSON.stringify(model)}`);
  }
  if (effort !== undefined && !CHATGPT_EFFORTS.includes(effort)) {
    throw new LaunchPlanError("invalid-effort", `Reasoning effort must be one of ${CHATGPT_EFFORTS.join(", ")}: ${JSON.stringify(effort)}`);
  }
  return { model, effort };
}

/**
 * Codex accepts native Windows separators inside the absolute path, but its
 * portable read-subtree form specifically requires a trailing `/**`. A path
 * without a drive letter is POSIX and keeps its own separators throughout.
 */
function readSubtreeGlob(path: string): string {
  const root = path.replace(/[\\/]+$/u, "");
  return `${/^[A-Za-z]:[\\/]/u.test(root) ? root.replaceAll("/", "\\") : root.replaceAll("\\", "/")}/**`;
}

function permissionProfileArguments(paths: readonly string[], readOnly: boolean, writableRoots: readonly string[]): readonly string[] {
  const readRules = paths.map((path) => `${JSON.stringify(readSubtreeGlob(path))}="read"`).join(",");
  const profile = writableRoots.length === 0
    ? `{extends=${JSON.stringify(readOnly ? ":read-only" : ":workspace")},filesystem={${readRules}}}`
    : `{workspace_roots={${writableRoots.map((root) => `${JSON.stringify(root)}=true`).join(",")}},filesystem={":root"="read",":workspace_roots"={"."="write"},":tmpdir"="write",":slash_tmp"="write",${readRules}}}`;
  return [
    "-c", `permissions.${WORKTREE_PERMISSION_PROFILE}=${profile}`,
    "-c", `default_permissions=${JSON.stringify(WORKTREE_PERMISSION_PROFILE)}`,
    "-c", 'approval_policy="never"',
  ];
}

function wrap(command: readonly string[], args: readonly string[], wrapper: SessionWrapperLayout | undefined, agentId: AgentId, _sessionId: SessionId, runtimeRoot: string): { readonly command: readonly string[]; readonly args: readonly string[]; readonly request?: RuntimeFile } {
  if (wrapper === undefined) return { command, args };
  const code = wrapper.mintLaunchCode();
  if (!SAFE_ID.test(code)) throw new LaunchPlanError("invalid-command", "Wrapper launch code is not safe as a file name");
  const request: RuntimeFile = {
    agentId,
    relativePath: `${runtimeRoot.replaceAll("\\", "/").replace(/\/+$/u, "")}/agents/${agentId}/launch-${code}.json`,
    contents: `${JSON.stringify({ command: [...command, ...args] })}\n`,
  };
  return {
    command: ["uv", "run", "--no-project", "--no-managed-python", wrapper.script],
    args: [wrapper.lockPathFor(agentId), "--request", request.relativePath],
    request,
  };
}
