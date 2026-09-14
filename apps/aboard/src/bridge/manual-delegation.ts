import type { AgentPlatformId } from "../platform/agent-platform.js";
import type { AgentType, ExecutionMode } from "../domain/contracts.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { protocolError, type BridgeRequestHandler } from "./protocol.js";

const TASKS = {
  explore: { type: "Explore", modes: ["auto"] },
  prototype: { type: "Prototype", modes: ["interactive", "auto"] },
  websearch: { type: "Web Search", modes: ["interactive", "auto"] },
  brainstorm: { type: "Brainstorm", modes: ["interactive"] },
  implement: { type: "General", modes: ["interactive", "auto"] },
  review: { type: "General", modes: ["interactive", "auto"] },
  general: { type: "General", modes: ["interactive", "auto"] },
} as const;
const SKILLS: Readonly<Record<string, string>> = {
  prototype: "prototype",
  websearch: "websearch",
  brainstorm: "grill-me",
  implement: "address-this",
  review: "review-this",
};
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  implement: "Issue Implementation",
  review: "Issue Review",
};
const SKILL_INVOCATION = /^[/\$][A-Za-z0-9_-]+(?:\s|$)/u;
export interface ManualDelegationLaunch {
  readonly requestId: string;
  readonly type: AgentType;
  readonly provider: AgentPlatformId;
  readonly executionMode: Exclude<ExecutionMode, "auto-run">;
  readonly prompt: string;
  /** Trusted skill selected by the ask-agent workflow, separate from user text. */
  readonly skill?: string;
  readonly cwd: string;
  readonly description: string;
}

export interface ManualDelegationLauncher {
  launch(request: ManualDelegationLaunch): Promise<{ readonly agentId: string; readonly sessionId: string; readonly terminalId: string }>;
}

function parse(body: unknown): ManualDelegationLaunch | undefined {
  // The published subagents JSON schema describes the wire shape. TASKS adds
  // Aboard's authorization policy, especially task-specific execution modes,
  // so this boundary check intentionally remains local to the bridge.
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["requestId", "task", "provider", "mode", "prompt", "cwd"].includes(key))) return undefined;
  if (typeof value.requestId !== "string" || value.requestId.trim().length === 0) return undefined;
  if (typeof value.task !== "string" || !(value.task in TASKS)) return undefined;
  const task = TASKS[value.task as keyof typeof TASKS];
  if (value.provider !== "claude" && value.provider !== "chatgpt") return undefined;
  if (value.mode !== "interactive" && value.mode !== "auto") return undefined;
  if (!(task.modes as readonly string[]).includes(value.mode)) return undefined;
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) return undefined;
  if (SKILL_INVOCATION.test(value.prompt.trim())) return undefined;
  if (typeof value.cwd !== "string" || value.cwd.trim().length === 0) return undefined;
  const skill = SKILLS[value.task];
  return {
    requestId: value.requestId,
    type: task.type,
    provider: value.provider,
    executionMode: value.mode,
    prompt: value.prompt,
    ...(skill === undefined ? {} : { skill }),
    cwd: value.cwd,
    description: DESCRIPTIONS[value.task] ?? task.type,
  };
}

function contains(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function createDelegationRoutes(
  launcher: ManualDelegationLauncher,
  options: { readonly workspaceRoot?: string } = {},
): BridgeRequestHandler {
  const launches = new Map<string, {
    readonly fingerprint: string;
    readonly outcome: Promise<{ readonly agentId: string; readonly sessionId: string; readonly terminalId: string }>;
  }>();
  return async (request) => {
    if (request.url.pathname !== "/delegations") return protocolError(404, "not-found", "Route not found");
    if (request.method !== "POST") return protocolError(404, "not-found", "Route not found");
    const parsed = parse(request.body);
    if (parsed === undefined) return protocolError(400, "invalid-request", "Delegation request is invalid");
    if (
      request.authorizationScope === "delegation"
      && options.workspaceRoot !== undefined
      && !contains(options.workspaceRoot, parsed.cwd)
    ) return protocolError(403, "forbidden", "The delegation credential cannot launch outside its workspace");
    const fingerprint = JSON.stringify(parsed);
    const existing = launches.get(parsed.requestId);
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      return protocolError(409, "conflict", "Delegation request ID was already used for different input");
    }
    try {
      const outcome = existing?.outcome ?? launcher.launch(parsed);
      if (existing === undefined) launches.set(parsed.requestId, { fingerprint, outcome });
      const launched = await outcome;
      return { status: 201, body: { ok: true, ...launched } };
    } catch (error) {
      return protocolError(409, "conflict", error instanceof Error ? error.message : "Delegation launch failed");
    }
  };
}
