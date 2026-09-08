import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { WriteCapability } from "../domain/capability.js";
import type { AgentId, SessionId } from "../domain/contracts.js";
import { buildCommandLine, canQuoteArgument, type ShellKind } from "../claude/shell.js";
import { MAX_COMMAND_LINE_CHARS, type LaunchPlan, LaunchPlanError, type PromptDelivery, type RuntimeFile, type SessionWrapperLayout } from "../claude/launch.js";
import type { PlatformLaunchPlan, PlatformLaunchRequest, PlatformResumeRequest } from "../platform/agent-platform.js";

export const DEFAULT_CHATGPT_COMMAND = ["codex"] as const;

export interface ChatGptLaunchConfiguration {
  readonly shape: "default";
  readonly declaredCommand?: readonly string[];
  readonly declaredModel?: string;
  readonly declaredEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function planChatGptLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan {
  return planChatGptSession(request, "start");
}

export function planChatGptSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan {
  return planChatGptSession(request, "resume");
}

function planChatGptSession(request: PlatformLaunchRequest | PlatformResumeRequest, kind: "start" | "resume"): PlatformLaunchPlan {
  if (request.agentType !== "interactive") throw new LaunchPlanError("shape-not-allowed", "ChatGPT currently supports attended interactive launches only");
  if (!SAFE_ID.test(request.agentId)) throw new LaunchPlanError("unsafe-agent-id", `Agent id is not safe as a file name: ${request.agentId}`);
  if (!UUID.test(request.sessionId)) throw new LaunchPlanError("invalid-session-id", kind === "start" ? "Provisional session id must be a UUID minted before launch" : "Saved session id must be a UUID");
  const configuration = request.configuration as ChatGptLaunchConfiguration;
  if (configuration.shape !== "default") throw new LaunchPlanError("shape-not-allowed", "interactive launches as Codex's default session");
  const command = configuration.declaredCommand ?? request.command ?? DEFAULT_CHATGPT_COMMAND;
  if (command.length === 0 || command.some((token) => token.trim().length === 0 || !canQuoteArgument(request.shell, token))) {
    throw new LaunchPlanError("invalid-command", `Launch command cannot be passed on a ${request.shell} command line`);
  }
  const threshold = request.maxInlinePromptChars ?? 4000;
  if (!Number.isInteger(threshold) || threshold < 0) throw new LaunchPlanError("invalid-threshold", "maxInlinePromptChars must be a non-negative integer");
  const runtimeRoot = request.runtimeDirectory ?? join(tmpdir(), "abd-runtime");
  const runtimeDirectory = `${runtimeRoot.replaceAll("\\", "/").replace(/\/+$/u, "")}/agents/${request.agentId}`;
  const hookScript = `${runtimeDirectory}/scripts/abd_hook.py`;
  const hook = (route: string): string => `uv run --no-project --no-managed-python "${hookScript.replaceAll('"', '\\"')}" ${route}`;
  const hookEntry = (route: string, matcher?: string): string =>
    `{${matcher === undefined ? "" : `matcher=${JSON.stringify(matcher)},`}hooks=[{type="command",command=${JSON.stringify(hook(route))}}]}`;
  const config = (event: string, entries: readonly string[]): readonly string[] => [
    "-c",
    `hooks.${event}=[${entries.join(",")}]`,
  ];
  const fixed = [
    "--dangerously-bypass-hook-trust",
    "-c", "features.hooks=true",
    ...config("SessionStart", [hookEntry("session-start", "startup|resume"), hookEntry("worker-reground", "compact")]),
    ...config("SessionEnd", [hookEntry("session-end")]),
    ...config("Stop", [hookEntry("worker-stop")]),
    ...config("PostCompact", [hookEntry("worker-post-compact", "manual|auto")]),
    ...(configuration.declaredModel === undefined ? [] : ["--model", configuration.declaredModel]),
    ...(configuration.declaredEffort === undefined ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(configuration.declaredEffort)}`]),
  ];
  const text = typeof request.prompt === "string" ? request.prompt.trim() : request.prompt?.text.trim();
  const planFor = (promptThreshold: number): { readonly promptDelivery: PromptDelivery; readonly spill?: RuntimeFile; readonly args: readonly string[]; readonly commandLine: string; readonly wrapperRequest?: RuntimeFile } => {
    let promptDelivery: PromptDelivery = "none";
    let spill: RuntimeFile | undefined;
    let promptArgs: string[] = [];
    if (text !== undefined && text.length > 0) {
      if (text.length <= promptThreshold && canQuoteArgument(request.shell, text)) {
        promptDelivery = "inline";
        promptArgs = ["--", text];
      } else {
        promptDelivery = "spilled";
        const identity = createHash("sha256").update(resolve(runtimeRoot)).digest("hex");
        const relativePath = `${join(tmpdir(), "abd-prompts", identity, request.agentId, "prompt.md").replaceAll("\\", "/")}`;
        if (/\s/u.test(relativePath)) throw new LaunchPlanError("unsafe-spill-path", `Prompt spill path must not contain whitespace: ${relativePath}`);
        spill = { agentId: request.agentId, relativePath, contents: `${text}\n` };
        promptArgs = ["--", `Your full task is in @${relativePath}; follow it.`];
      }
    }
    const args = [...(kind === "resume" ? ["resume", request.sessionId] : []), ...fixed, ...promptArgs];
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
  const writeCapability: WriteCapability = "write-capable";
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
    requiresWriteLease: false,
    promptDelivery: built.promptDelivery,
    runtimeDirectory,
    ...(built.spill === undefined ? {} : { spill: built.spill }),
    ...(built.wrapperRequest === undefined ? {} : { wrapperRequest: built.wrapperRequest }),
  };
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
