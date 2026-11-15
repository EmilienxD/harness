import { isRequestedEffort, type RequestedEffort } from "../platform/effort.js";
import type { AgentPlatformId } from "../platform/agent-platform.js";
import { AGENT_PLATFORM_IDS, type AgentType, type AgentSession, type ExecutionMode, type TerminalId } from "../domain/contracts.js";
import { validateResumeMessage, type TerminalController } from "../platform/terminals.js";
import { sanitizePromptCommands } from "../platform/prompt-commands.js";
import { DELEGATION_TASKS, type DelegationTask } from "../platform/launch-configuration.js";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { protocolError, type BridgeRequestHandler } from "./protocol.js";
import { ISSUE_DIFFICULTIES, type IssueDifficulty } from "../shared/labels.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { normalizeProjectPath } from "./command-endpoint.js";

/** A claim whose launch never reported an outcome: callers must verify, not retry. */
class StartupUncertain extends Error {}
export interface ManualDelegationLaunch {
  readonly model?: string;
  readonly effort?: RequestedEffort;
  readonly difficulty?: IssueDifficulty;
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
  /** Trusted skill selected by the delegation workflow, separate from user text. */
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
  readonly executionMode: "interactive" | "auto" | "loop";
  readonly cwd: string;
  readonly description: string;
  readonly parentSessionId?: string;
}

/** Only a live, bound interactive provider process can receive a continuation as input. */
export async function resumeInOpenTerminal(
  request: ManualDelegationLaunch,
  binding: DelegationBinding,
  saved: AgentSession | undefined,
  terminals: TerminalController,
  prepare: (terminalId: TerminalId) => Promise<void>,
): Promise<{ readonly agentId: string; readonly sessionId: string; readonly terminalId: string } | undefined> {
  if ((request.executionMode !== "interactive" && request.executionMode !== "loop") || binding.executionMode !== request.executionMode || saved?.executionMode !== request.executionMode) return undefined;
  if (saved.platform !== binding.provider || saved.sessionBinding !== "bound" || saved.sessionId !== binding.sessionId || saved.identity.agentId !== binding.agentId) return undefined;
  if (saved.lifecycle.status !== "running" && saved.lifecycle.status !== "awaiting-user") return undefined;
  const terminalId = terminals.liveTerminalForAgent(saved.identity.agentId);
  if (terminalId === undefined || terminalId !== saved.terminal.terminalId || terminalId !== binding.terminalId) return undefined;
  const terminal = terminals.get(terminalId);
  if (terminal.backend === "process" || terminal.sessionId !== binding.sessionId || terminal.cwd !== binding.cwd) return undefined;
  validateResumeMessage(request.prompt);
  await prepare(terminalId);
  await terminals.sendResumeMessage(terminalId, request.prompt);
  return { agentId: binding.agentId, sessionId: binding.sessionId, terminalId };
}

function bindingPath(directory: string, sessionId: string): string {
  return join(directory, `session-${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

export type ResumeAction = "reopen" | "fork" | "reuse-terminal";
export interface ResumeAuthority { readonly task: DelegationTask; readonly cwd: string; readonly action: ResumeAction; }

/** Local history is a reuse hint, never authority to execute a continuation. */
export async function resolveResumeBinding(
  request: ManualDelegationLaunch,
  local: DelegationBinding | undefined,
  allocateAgentId: () => string,
  verify: (request: ManualDelegationLaunch, local?: DelegationBinding) => Promise<ResumeAuthority> = verifyResumeAuthority,
): Promise<DelegationBinding & { readonly resumeAction: ResumeAction }> {
  if (!request.harnessSessionId || !request.resumeSessionId) throw new Error("Delegated resume requires its stable Harness and native identities");
  const durable = await verify(request, local);
  if (local && local.sessionId === request.resumeSessionId && local.provider === request.provider
    && local.executionMode === request.executionMode && normalizeProjectPath(local.cwd) === normalizeProjectPath(request.cwd)
    && local.parentSessionId === request.parentSessionId
    && (request.resumeAgentId === undefined || local.agentId === request.resumeAgentId)) return { ...local, resumeAction: durable.action };
  if (durable.action === "reuse-terminal") throw new Error("The live execution has no matching local terminal; resume refused");
  return {
    resumeAction: durable.action,
    harnessSessionId: request.harnessSessionId, agentId: allocateAgentId(), sessionId: request.resumeSessionId,
    type: durable.task === "loop" ? "general" : durable.task, task: durable.task, provider: request.provider, executionMode: request.executionMode,
    cwd: durable.cwd, description: request.description,
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.harnessPython === undefined ? {} : { harnessPython: request.harnessPython }),
    ...(request.harnessStateDirectory === undefined ? {} : { harnessStateDirectory: request.harnessStateDirectory }),
    ...(request.harnessRuntimePath === undefined ? {} : { harnessRuntimePath: request.harnessRuntimePath }),
  };
}

async function verifyResumeAuthority(request: ManualDelegationLaunch, local?: DelegationBinding): Promise<ResumeAuthority> {
  if (!request.harnessPython || !request.harnessRuntimePath || !request.harnessStateDirectory || !request.executionId) throw new Error("Durable Harness resume authority is unavailable; adoption refused");
  const identity = {
    requestId: request.requestId, harnessSessionId: request.harnessSessionId,
    parentSessionId: request.parentSessionId, executionId: request.executionId,
    provider: request.provider, mode: request.executionMode, cwd: request.cwd,
    resumeSessionId: request.resumeSessionId, forkSessionId: request.forkSessionId,
    hostClaim: randomUUID(), localAgentId: local?.agentId, localTerminalId: local?.terminalId,
  };
  const { stdout } = await promisify(execFile)(request.harnessPython, ["-m", "subagents_runtime.resume_context", JSON.stringify(identity)], {
    cwd: request.cwd,
    env: { ...process.env, HARNESS_STATE_DIR: request.harnessStateDirectory, PYTHONPATH: [request.harnessRuntimePath, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
    windowsHide: true, timeout: 15_000,
  });
  const value = JSON.parse(stdout) as { task?: unknown; cwd?: unknown; action?: unknown };
  if (!DELEGATION_TASKS.includes(value.task as DelegationTask) || typeof value.cwd !== "string"
    || (value.action !== "reopen" && value.action !== "fork" && value.action !== "reuse-terminal")) throw new Error("Invalid durable resume metadata");
  return { task: value.task as DelegationTask, cwd: value.cwd, action: value.action };
}

export async function readDelegationBinding(directory: string, sessionId: string): Promise<DelegationBinding | undefined> {
  try { return JSON.parse(await readFile(bindingPath(directory, sessionId), "utf8")) as DelegationBinding; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Resolve a delegated child to the provider session owned by its parent terminal. */
export async function delegationParentSession(directory: string, childSessionId: string): Promise<string | undefined> {
  const child = await readDelegationBinding(directory, childSessionId);
  return child?.parentSessionId === undefined ? undefined : providerSession(directory, child.parentSessionId, child);
}

/** A delegated Harness session runs under its own provider session; an observed one shares its ID. */
export async function providerSession(directory: string, harnessSessionId: string,
  runtime?: Pick<ManualDelegationLaunch, "harnessPython" | "harnessRuntimePath" | "harnessStateDirectory">,
): Promise<string> {
  if (runtime?.harnessPython && runtime.harnessRuntimePath && runtime.harnessStateDirectory) {
    const { stdout } = await promisify(execFile)(runtime.harnessPython, ["-m", "subagents_runtime.resume_context", "--session", harnessSessionId], {
      env: { ...process.env, HARNESS_STATE_DIR: runtime.harnessStateDirectory, PYTHONPATH: [runtime.harnessRuntimePath, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
      windowsHide: true, timeout: 15_000,
    });
    const value = JSON.parse(stdout) as { providerSessionId?: unknown };
    if (typeof value.providerSessionId === "string" && value.providerSessionId) return value.providerSessionId;
  }
  return (await readDelegationBinding(directory, harnessSessionId))?.sessionId ?? harnessSessionId;
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
  // Validate the published subagents wire shape before claiming a launch.
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const identities = ["harnessSessionId", "executionId", "parentSessionId", "resumeAgentId", "resumeSessionId", "forkSessionId", "harnessStateDirectory", "harnessRuntimePath", "harnessPython"] as const;
  if (identities.some((key) => value[key] !== undefined && (typeof value[key] !== "string" || (value[key] as string).trim().length === 0))) return undefined;
  if (value.resumeAgentId !== undefined && value.resumeSessionId === undefined) return undefined;
  if (value.forkSessionId !== undefined && value.forkSessionId !== value.resumeSessionId) return undefined;
  if (Object.keys(value).some((key) => !["requestId", "skill", "provider", "mode", "model", "effort", "prompt", "cwd", "difficulty", ...identities].includes(key))) return undefined;
  if (value.effort !== undefined && !isRequestedEffort(value.effort)) return undefined;
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.trim().length === 0)) return undefined;
  if (value.difficulty !== undefined && !ISSUE_DIFFICULTIES.includes(value.difficulty as IssueDifficulty)) return undefined;
  if (typeof value.requestId !== "string" || value.requestId.trim().length === 0) return undefined;
  if (value.skill !== undefined && (typeof value.skill !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.skill))) return undefined;
  if (typeof value.provider !== "string" || !AGENT_PLATFORM_IDS.includes(value.provider as AgentPlatformId)) return undefined;
  if (value.mode !== "interactive" && value.mode !== "auto" && value.mode !== "loop") return undefined;
  if (value.provider === "pi" && value.mode === "loop") return undefined;
  if (value.mode === "loop" && value.skill !== undefined) return undefined;
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) return undefined;
  if (typeof value.cwd !== "string" || value.cwd.trim().length === 0) return undefined;
  const skill = value.skill as string | undefined;
  return {
    ...Object.fromEntries(identities.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])),
    requestId: value.requestId,
    type: "general",
    task: value.mode === "loop" ? "loop" : "general",
    provider: value.provider as AgentPlatformId,
    executionMode: value.mode,
    ...(value.effort === undefined ? {} : { effort: value.effort as RequestedEffort }),
    ...(value.model === undefined ? {} : { model: (value.model as string).trim() }),
    ...(value.difficulty === undefined ? {} : { difficulty: value.difficulty as IssueDifficulty }),
    prompt: value.prompt,
    ...(skill === undefined ? {} : { skill }),
    cwd: value.cwd,
    description: value.mode === "loop" ? "Implementer" : "general",
  };
}

function contains(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function registeredWorktree(root: string, candidate: string): Promise<boolean> {
  try {
    const canonical = await realpath(candidate);
    const git = promisify(execFile);
    const { stdout } = await git("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], { windowsHide: true, timeout: 10_000 });
    for (const field of stdout.split("\0")) {
      if (!field.startsWith("worktree ")) continue;
      try {
        if (!contains(await realpath(field.slice(9)), canonical)) continue;
        // Registrations outlive deleted worktrees. The candidate must still share
        // this repository's metadata, not merely occupy one of its old paths.
        const commonDirectories = await Promise.all([root, canonical].map(async (cwd) => {
          const result = await git("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { windowsHide: true, timeout: 10_000 });
          return realpath(result.stdout.trim());
        }));
        return relative(commonDirectories[0]!, commonDirectories[1]!) === "";
      } catch { /* Removed worktrees do not grant launch access. */ }
    }
  } catch { /* No usable repository/worktree fact: retain the workspace fence. */ }
  return false;
}

export function createDelegationRoutes(
  launcher: ManualDelegationLauncher,
  options: {
    readonly workspaceRoot?: string;
    readonly workspaceRoots?: readonly string[];
    readonly stateDirectory?: string;
  } = {},
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
      && !(await Promise.all((options.workspaceRoots ?? [options.workspaceRoot]).map(async (root) => {
        try { return contains(await realpath(root), await realpath(parsed.cwd)) || await registeredWorktree(root, parsed.cwd); }
        catch { return false; }
      }))).some(Boolean)
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
        const prompt = sanitizePromptCommands(parsed.prompt, parsed.provider);
        const launchRequest = { ...parsed, prompt };
        const launched = await (parsed.resumeSessionId === undefined ? launcher.launch(launchRequest)
          : launcher.resume?.(launchRequest) ?? Promise.reject(new Error("Delegation resume is unavailable")));
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
      // Keep host branding out of the neutral delegation diagnostics.
      const detail = error instanceof Error ? error.message.replace(/\baboard\b/giu, "the runtime") : "Delegation launch failed";
      return protocolError(409, "conflict", detail);
    }
  };
}
