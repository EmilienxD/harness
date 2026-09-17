import type { AgentPlatformId } from "../platform/agent-platform.js";
import type { AgentType, ExecutionMode } from "../domain/contracts.js";
import type { DelegationTask } from "../platform/launch-configuration.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { protocolError, type BridgeRequestHandler } from "./protocol.js";

const TASKS = {
  explore: { type: "explore", modes: ["auto"] },
  prototype: { type: "prototype", modes: ["interactive"] },
  websearch: { type: "websearch", modes: ["interactive", "auto"] },
  brainstorm: { type: "brainstorm", modes: ["interactive"] },
  address: { type: "general", modes: ["interactive", "auto"] },
  review: { type: "general", modes: ["interactive", "auto"] },
  general: { type: "general", modes: ["interactive", "auto"] },
} as const;
const SKILLS: Readonly<Record<string, string>> = {
  prototype: "prototype",
  websearch: "websearch",
  brainstorm: "grill-me",
  address: "address-this",
  review: "review-this",
};
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  address: "Address",
  review: "Review",
};
const SKILL_INVOCATION = /^[/\$][A-Za-z0-9_-]+(?:\s|$)/u;

/** A claim whose launch never reported an outcome: callers must verify, not retry. */
class StartupUncertain extends Error {}
export interface ManualDelegationLaunch {
  readonly forkSessionId?: string;
  readonly harnessPython?: string;
  readonly harnessStateDirectory?: string;
  readonly harnessRuntimePath?: string;
  readonly harnessSessionId?: string;
  readonly executionId?: string;
  readonly parentSessionId?: string;
  readonly resumeAgentId?: string;
  readonly resumeSessionId?: string;
  readonly requestId: string;
  readonly type: AgentType;
  readonly task: DelegationTask;
  readonly provider: AgentPlatformId;
  readonly executionMode: Exclude<ExecutionMode, "auto-run">;
  readonly prompt: string;
  /** Trusted skill selected by the work-with-agent workflow, separate from user text. */
  readonly skill?: string;
  readonly cwd: string;
  readonly description: string;
}

export interface ManualDelegationLauncher {
  launch(request: ManualDelegationLaunch): Promise<{ readonly agentId: string; readonly sessionId: string; readonly terminalId: string }>;
  resume?(request: ManualDelegationLaunch): Promise<{ readonly agentId: string; readonly sessionId: string; readonly terminalId: string }>;
}

export interface DelegationBinding {
  readonly harnessPython?: string;
  readonly harnessSessionId?: string;
  readonly terminalId?: string;
  readonly harnessStateDirectory?: string;
  readonly harnessRuntimePath?: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly type: AgentType;
  readonly task: DelegationTask;
  readonly provider: AgentPlatformId;
  readonly executionMode: "interactive" | "auto";
  readonly cwd: string;
  readonly description: string;
  readonly parentSessionId?: string;
}

function bindingPath(directory: string, sessionId: string): string {
  return join(directory, `session-${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

export async function readDelegationBinding(directory: string, sessionId: string): Promise<DelegationBinding | undefined> {
  try { return JSON.parse(await readFile(bindingPath(directory, sessionId), "utf8")) as DelegationBinding; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function continueHarnessDelegation(
  directory: string,
  target: { readonly agentId: string; readonly sessionId: string; readonly platform: AgentPlatformId; readonly prompt?: string },
  run: (binding: DelegationBinding, message: string) => Promise<void>,
): Promise<{ readonly agentId: string; readonly sessionId: string; readonly terminalId: string } | undefined> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  for (const name of names.filter((value) => /^session-[a-f0-9]{64}\.json$/u.test(value))) {
    const binding = JSON.parse(await readFile(join(directory, name), "utf8")) as DelegationBinding;
    if (binding.agentId !== target.agentId || binding.sessionId !== target.sessionId || binding.provider !== target.platform) continue;
    if (!binding.harnessSessionId || !binding.parentSessionId) throw new Error("Delegation's saved Harness identity is unavailable; resume refused");
    if (!target.prompt?.trim()) throw new Error("Delegated continuations require a next message");
    await run(binding, target.prompt);
    const continued = await readDelegationBinding(directory, binding.harnessSessionId);
    if (!continued?.terminalId) throw new Error("Delegated continuation startup could not be verified");
    return { agentId: continued.agentId, sessionId: continued.sessionId, terminalId: continued.terminalId };
  }
  return undefined;
}

function parse(body: unknown): ManualDelegationLaunch | undefined {
  // The published subagents JSON schema describes the wire shape. TASKS adds
  // Aboard's authorization policy, especially task-specific execution modes,
  // so this boundary check intentionally remains local to the bridge.
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const identities = ["harnessSessionId", "executionId", "parentSessionId", "resumeAgentId", "resumeSessionId", "forkSessionId", "harnessStateDirectory", "harnessRuntimePath", "harnessPython"] as const;
  if (identities.some((key) => value[key] !== undefined && (typeof value[key] !== "string" || (value[key] as string).trim().length === 0))) return undefined;
  if ((value.resumeAgentId === undefined) !== (value.resumeSessionId === undefined)) return undefined;
  if (value.forkSessionId !== undefined && value.forkSessionId !== value.resumeSessionId) return undefined;
  if (Object.keys(value).some((key) => !["requestId", "task", "provider", "mode", "prompt", "cwd", ...identities].includes(key))) return undefined;
  if (typeof value.requestId !== "string" || value.requestId.trim().length === 0) return undefined;
  if (typeof value.task !== "string" || !(value.task in TASKS)) return undefined;
  const task = TASKS[value.task as keyof typeof TASKS];
  if (value.provider !== "claude" && value.provider !== "chatgpt") return undefined;
  if (value.mode !== "interactive" && value.mode !== "auto") return undefined;
  if (!(task.modes as readonly string[]).includes(value.mode)) return undefined;
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) return undefined;
  if (value.resumeAgentId === undefined && SKILL_INVOCATION.test(value.prompt.trim())) return undefined;
  if (typeof value.cwd !== "string" || value.cwd.trim().length === 0) return undefined;
  const skill = SKILLS[value.task];
  return {
    ...Object.fromEntries(identities.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])),
    requestId: value.requestId,
    type: task.type,
    task: value.task as DelegationTask,
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
  options: {
    readonly workspaceRoot?: string;
    readonly stateDirectory?: string;
    readonly focusParent?: (sessionId: string) => boolean;
  } = {},
): BridgeRequestHandler {
  const launches = new Map<string, {
    readonly fingerprint: string;
    readonly outcome: Promise<{ readonly agentId: string; readonly sessionId: string; readonly terminalId: string }>;
  }>();
  return async (request) => {
    if (request.url.pathname === "/delegations/focus-parent") {
      if (request.method !== "POST") return protocolError(404, "not-found", "Route not found");
      if (request.authorizationScope !== undefined && request.authorizationScope !== "full") {
        return protocolError(403, "forbidden", "Only an Aboard-launched agent can focus its parent");
      }
      if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
        return protocolError(400, "invalid-request", "Parent focus request is invalid");
      }
      const focusBody = request.body as Record<string, unknown>;
      const childSessionId = focusBody.childSessionId;
      if (Object.keys(focusBody).length !== 1 || typeof childSessionId !== "string" || !childSessionId.trim()) {
        return protocolError(400, "invalid-request", "Parent focus request is invalid");
      }
      if (options.stateDirectory === undefined || options.focusParent === undefined) {
        return protocolError(404, "not-found", "Delegation binding is unavailable");
      }
      const child = await readDelegationBinding(options.stateDirectory, childSessionId);
      if (child?.parentSessionId === undefined) return protocolError(404, "not-found", "Delegation parent is unavailable");
      const parent = await readDelegationBinding(options.stateDirectory, child.parentSessionId);
      options.focusParent(parent?.sessionId ?? child.parentSessionId);
      return { status: 204 };
    }
    if (request.url.pathname !== "/delegations") return protocolError(404, "not-found", "Route not found");
    if (request.method !== "POST") return protocolError(404, "not-found", "Route not found");
    const parsed = parse(request.body);
    if (parsed === undefined) return protocolError(400, "invalid-request", "Delegation request is invalid");
    if (
      request.authorizationScope === "delegation"
      && options.workspaceRoot !== undefined
      && !contains(options.workspaceRoot, parsed.cwd)
    ) return protocolError(403, "forbidden", "The delegation credential cannot launch outside its workspace");
    const fingerprint = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
    const existing = launches.get(parsed.requestId);
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      return protocolError(409, "conflict", "Delegation request ID was already used for different input");
    }
    try {
      const start = async () => {
        let recordPath: string | undefined;
        if (options.stateDirectory !== undefined) {
          await mkdir(options.stateDirectory, { recursive: true });
          recordPath = join(options.stateDirectory, `${createHash("sha256").update(parsed.requestId).digest("hex")}.json`);
          try {
            const claim = await open(recordPath, "wx", 0o600);
            await claim.writeFile(JSON.stringify({ fingerprint, state: "uncertain" }));
            await claim.close();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const saved = JSON.parse(await readFile(recordPath, "utf8")) as { fingerprint: string; outcome?: { agentId: string; sessionId: string; terminalId: string } };
            if (saved.fingerprint !== fingerprint) throw new Error("Delegation request ID was already used for different input");
            if (saved.outcome !== undefined) return saved.outcome;
            throw new StartupUncertain("Delegation startup is uncertain; verify the existing execution before retrying");
          }
        }
        const launched = await (parsed.resumeAgentId === undefined ? launcher.launch(parsed)
          : launcher.resume?.(parsed) ?? Promise.reject(new Error("Delegation resume is unavailable")));
        if (recordPath !== undefined) {
          if (parsed.harnessSessionId !== undefined && options.stateDirectory !== undefined) {
            const binding: DelegationBinding = { harnessSessionId: parsed.harnessSessionId, terminalId: launched.terminalId, agentId: launched.agentId, sessionId: launched.sessionId, type: parsed.type, task: parsed.task, provider: parsed.provider, executionMode: parsed.executionMode, cwd: parsed.cwd, description: parsed.description, ...(parsed.harnessPython === undefined ? {} : { harnessPython: parsed.harnessPython }), ...(parsed.parentSessionId === undefined ? {} : { parentSessionId: parsed.parentSessionId }), ...(parsed.harnessStateDirectory === undefined ? {} : { harnessStateDirectory: parsed.harnessStateDirectory }), ...(parsed.harnessRuntimePath === undefined ? {} : { harnessRuntimePath: parsed.harnessRuntimePath }) };
            const destination = bindingPath(options.stateDirectory, parsed.harnessSessionId);
            await writeFile(`${destination}.tmp`, JSON.stringify(binding), { mode: 0o600 });
            await rename(`${destination}.tmp`, destination);
          }
          const temporary = `${recordPath}.completed`;
          await writeFile(temporary, JSON.stringify({ fingerprint, state: "started", outcome: launched }), { mode: 0o600 });
          await rename(temporary, recordPath);
        }
        return launched;
      };
      const outcome = existing?.outcome ?? start();
      if (existing === undefined) launches.set(parsed.requestId, { fingerprint, outcome });
      const launched = await outcome;
      return { status: 201, body: { ok: true, ...launched } };
    } catch (error) {
      if (error instanceof StartupUncertain) return protocolError(409, "startup-uncertain", error.message);
      return protocolError(409, "conflict", error instanceof Error ? error.message : "Delegation launch failed");
    }
  };
}
