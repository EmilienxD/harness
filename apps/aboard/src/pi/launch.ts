import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isAutoRunWorkerType, isHeadlessExecution } from "../domain/contracts.js";
import type { PlatformLaunchPlan, PlatformLaunchRequest } from "../platform/agent-platform.js";
import { DEFAULT_RUNTIME_DIRECTORY, LaunchPlanError, MAX_COMMAND_LINE_CHARS, promptSpillRoot, requiresWriteLease, taskPromptPath, type RuntimeFile } from "../platform/launch.js";
import { promptFileReference, skillInvocation, worktreeGuidance } from "../platform/prompts.js";
import { buildCommandLine, canQuoteArgument } from "../platform/shell.js";

export const PI_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface PiLaunchConfiguration {
  readonly shape: "default" | "explore" | "skill";
  readonly skillName?: string;
  readonly declaredCommand?: readonly string[];
  readonly declaredModel?: string;
  readonly declaredEffort?: (typeof PI_EFFORTS)[number];
}
export function planPiSession(request: PlatformLaunchRequest, kind: "start" | "resume"): PlatformLaunchPlan {
  const config = request.configuration as PiLaunchConfiguration;
  const explore = request.agentType === "explore";
  const worker = isAutoRunWorkerType(request.agentType);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(request.agentId)) throw new LaunchPlanError("unsafe-agent-id", "Invalid agent ID");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(request.sessionId)) throw new LaunchPlanError("invalid-session-id", "Invalid Pi session ID");
  if (request.forkSessionId !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(request.forkSessionId)) throw new LaunchPlanError("invalid-session-id", "Invalid Pi fork session ID");
  if (config.shape !== (explore ? "explore" : worker ? "skill" : "default") || (worker && config.skillName !== `${request.agentType}-this`)) throw new LaunchPlanError("shape-not-allowed", "Invalid Pi launch shape");
  const command = config.declaredCommand ?? request.command ?? ["pi"];
  if (command.length === 0 || command.some((v) => !v.trim() || !canQuoteArgument(request.shell, v))) throw new LaunchPlanError("invalid-command", "Invalid Pi command");
  const root = resolve(request.runtimeDirectory ?? DEFAULT_RUNTIME_DIRECTORY);
  const runtimeDirectory = join(root, "agents", request.agentId);
  const threshold = request.maxInlinePromptChars ?? 4000;
  if (!Number.isInteger(threshold) || threshold < 0) throw new LaunchPlanError("invalid-threshold", "Invalid prompt threshold");
  const restricted = explore || worker || request.autoRunRestricted === true || request.restrictions?.denySubagents === true || request.restrictions?.denyWeb === true || (request.restrictions?.deniedCommands?.length ?? 0) > 0;
  const tools = explore ? ["read", "grep", "find", "ls"] : ["read", "grep", "find", "ls", "bash", ...(process.platform === "win32" ? ["powershell"] : []), "edit", "write"];
  const guard: RuntimeFile | undefined = restricted ? { agentId: request.agentId, relativePath: join(runtimeDirectory, "guard.json"), contents: JSON.stringify({ denySubagents: true, denyCommands: request.restrictions?.deniedCommands ?? [], allowedTools: tools, readOnly: explore }) } : undefined;
  const model = request.modelOverride ?? config.declaredModel ?? request.model;
  if (model !== undefined && (!model.trim() || model.startsWith("-") || /[\r\n\0]/u.test(model))) throw new LaunchPlanError("invalid-model", "Invalid Pi model");
  const rawEffort = request.effortOverride ?? config.declaredEffort ?? request.effort;
  const effort = rawEffort === "none" ? "off" : rawEffort === "ultra" ? "max" : rawEffort;
  if (effort !== undefined && !PI_EFFORTS.includes(effort as never)) throw new LaunchPlanError("invalid-effort", "Invalid Pi thinking level");
  const assignSession = kind === "start" && request.forkSessionId === undefined;
  const fixed = [...(assignSession ? [] : [kind === "resume" ? "--session" : "--session-id", request.sessionId]), ...(request.forkSessionId === undefined ? [] : ["--fork", request.forkSessionId]), "--extension", join(runtimeDirectory, "abd_pi.ts"), ...(restricted ? ["--no-extensions", "--no-mcp", "--no-prompt-templates", "--tools", tools.join(",")] : []), ...(model === undefined ? [] : ["--model", model]), ...(effort === undefined ? [] : ["--thinking", effort]), ...(isHeadlessExecution(request.agentType, request.executionMode) ? ["--mode", "json"] : [])];
  const text = typeof request.prompt === "string" ? request.prompt : request.prompt?.text;
  if (kind === "start" && (explore || worker) && !text?.trim()) throw new LaunchPlanError("missing-prompt", "Pi workers need their initial task");
  const task: RuntimeFile | undefined = worker && kind === "start" && text !== undefined ? { agentId: request.agentId, relativePath: taskPromptPath(root, request.agentId, request.promptRoot), contents: text } : undefined;
  const skill = kind === "start" ? config.skillName ?? request.skill : undefined;
  const invocation = skill === undefined ? "" : `${skillInvocation("/skill:", skill)} `;
  const build = (limit: number) => {
    const inline = text === undefined ? undefined : `${invocation}${text}`;
    const spilled = inline !== undefined && (inline.length > limit || !canQuoteArgument(request.shell, inline));
    const spill = spilled ? { agentId: request.agentId, relativePath: task?.relativePath ?? join(promptSpillRoot(root, request.promptRoot), request.agentId, `${randomUUID()}.md`), contents: text! } : undefined;
    const args = [...fixed, ...(inline === undefined ? [] : spill === undefined ? ["--", inline] : skill === undefined ? [`@${spill.relativePath}`] : ["--", `${invocation}${promptFileReference(spill.relativePath)}`])];
    let wrapperRequest: RuntimeFile | undefined;
    let commandLine: string;
    if (request.wrapper === undefined) commandLine = buildCommandLine(request.shell, command, args);
    else {
      const code = request.wrapper.mintLaunchCode();
      if (!/^[A-Za-z0-9._-]+$/u.test(code)) throw new LaunchPlanError("invalid-command", "Invalid wrapper capability");
      wrapperRequest = { agentId: request.agentId, relativePath: join(runtimeDirectory, `launch-${code}.json`), contents: JSON.stringify({ command: [...command, ...args] }) };
      commandLine = buildCommandLine(request.shell, ["uv", "run", "--no-project", "--no-managed-python", request.wrapper.script], [request.wrapper.lockPathFor(request.agentId), "--request", wrapperRequest.relativePath]);
    }
    return { args, spill, wrapperRequest, commandLine, promptDelivery: inline === undefined ? "none" as const : spilled ? "spilled" as const : "inline" as const };
  };
  let built = build(threshold);
  if (built.commandLine.length > MAX_COMMAND_LINE_CHARS[request.shell]) built = build(0);
  if (built.commandLine.length > MAX_COMMAND_LINE_CHARS[request.shell]) throw new LaunchPlanError("command-line-too-long", "Pi command exceeds shell limit");
  const writeCapability = explore ? "read-only" : "write-capable";
  const originalPaths = request.restrictions?.protectedPaths ?? [];
  const checkoutGuidance = originalPaths.length === 0 ? {}
    : { ABOARD_WORKTREE_GUIDANCE: worktreeGuidance(request.cwd ?? process.cwd(), originalPaths) };
  return { platform: "pi", kind, agentId: request.agentId, sessionId: request.sessionId, agentType: request.agentType, shell: request.shell, command, args: built.args, commandLine: built.commandLine, writeCapability, requiresWriteLease: requiresWriteLease(request.agentType, writeCapability), promptDelivery: built.promptDelivery, runtimeDirectory, providerEnvironment: { ABOARD_PI_EXTENSION: join(runtimeDirectory, "abd_pi.ts"), ABOARD_PI_SETTLEMENT: join(runtimeDirectory, "settlement.json"), ABOARD_PI_CWD: request.cwd ?? process.cwd(), ABOARD_PI_ASSIGN_SESSION: assignSession ? "1" : "0", ...checkoutGuidance, ...(guard === undefined ? {} : { ABOARD_GUARD_PATH: guard.relativePath }) }, ...(guard === undefined ? {} : { guard }), ...(task === undefined ? {} : { task }), ...(built.spill === undefined ? {} : { spill: built.spill }), ...(built.wrapperRequest === undefined ? {} : { wrapperRequest: built.wrapperRequest }) };
}
