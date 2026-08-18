import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ManagerPersistenceDto, AgentId, SessionId, TerminalId, IsoTimestamp } from "../domain/contracts.js";
import { parseManagerPersistenceDto } from "../domain/validation.js";
import { MANAGER_AGENT_NAME, resolveLaunchConfiguration, type EffortLevel, type LaunchConfiguration, type SessionWrapperLayout, planLaunch, planManagerResume } from "./launch.js";
import { AGENT_DEFINITION_DIRECTORY, aboardMcpServerFrontmatter, agentDefinitionPath, parseManagerAgentDefinition, sanitizeAgentDefinition } from "../scaffold/agent-definition.js";
import { sessionIsResumable } from "./sessions.js";
import type { PromptSpillStore } from "./spill.js";
import type { ShellKind } from "./shell.js";
import type { TerminalController, TerminalSnapshot } from "./terminals.js";

/** Proof-of-life arm for a Manager launch; the TUI has longer to boot than a worker because the first SessionStart briefing may run git/gh work. */
export const MANAGER_STARTUP_PROOF_TIMEOUT_MS = 120_000;

export interface ManagerStore { load(): Promise<ManagerPersistenceDto | undefined>; save(value: ManagerPersistenceDto): Promise<void>; }
export class FileManagerStore implements ManagerStore {
  readonly #path: string;
  public constructor(workspaceRoot: string) { this.#path = join(workspaceRoot, ".aboard", "runtime", "manager.json"); }
  public async load(): Promise<ManagerPersistenceDto | undefined> {
    let contents: string;
    try { contents = await readFile(this.#path, "utf8"); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try { const parsed: unknown = JSON.parse(contents); const result = parseManagerPersistenceDto(parsed); return result.ok ? result.value : undefined; }
    catch (error: unknown) { if (error instanceof SyntaxError) return undefined; throw error; }
  }
  public async save(value: ManagerPersistenceDto): Promise<void> { const temporary = `${this.#path}.${process.pid}.tmp`; await mkdir(dirname(this.#path), { recursive: true }); await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }); await rm(this.#path, { force: true }); await rename(temporary, this.#path); }
}

/**
 * The rewritten Manager definition, plus the `model:` and `effort:` it declares.
 * Those two are also passed as `--model`/`--effort`, because `--resume` reads no
 * definition of its own and a resumed session must not silently fall back to the
 * session defaults (see `LaunchConfiguration`).
 */
export type ManagerLaunchDefinition = Extract<LaunchConfiguration, { shape: "agent-defined" }>;

/**
 * Reads `.aboard/agents/manager.md` into the configuration every Manager
 * command line is built from.
 *
 * A missing or invalid definition is fatal, where it used to be survivable. The
 * definition is no longer a refinement of the configured defaults: it carries
 * the persona and the tool allowlist themselves, so a launch without it is not
 * a Manager with default settings but a stock Claude Code session holding
 * `Edit`, `Write`, and an unrestricted `Bash` in the Manager's terminal — the
 * one agent the spec forbids from implementing anything.
 */
export async function readManagerLaunchDefinition(workspaceRoot: string): Promise<ManagerLaunchDefinition> {
  let contents: string;
  try { contents = await readFile(agentDefinitionPath(workspaceRoot, MANAGER_AGENT_NAME), "utf8"); }
  catch { throw new Error(`Cannot read the Manager definition at ${AGENT_DEFINITION_DIRECTORY}/${MANAGER_AGENT_NAME}.md. Run the aboard scaffold to restore it.`); }
  const parsed = parseManagerAgentDefinition(contents);
  if (!parsed.ok) throw new Error(`Invalid Manager agent definition: ${parsed.reason}`);
  // The rewrite is what the launch actually runs: same document, tool list
  // narrowed, unresolved keys — `color:` among them — copied through.
  const sanitized = sanitizeAgentDefinition(parsed.value);
  const configuration = resolveLaunchConfiguration({
    agentName: MANAGER_AGENT_NAME,
    systemPrompt: sanitized.prompt,
    declaredTools: sanitized.tools,
    declaredDescription: sanitized.description,
    extraFrontmatter: sanitized.extraFrontmatter,
    // The delegation surface is registered here and nowhere else, so it exists
    // for this session only — no project-scoped `.mcp.json` entry, and so no
    // worker or hand-started session paying for tool descriptions it may not use.
    declaredMcpServers: aboardMcpServerFrontmatter(),
    declaredModel: sanitized.model,
    declaredEffort: sanitized.effort,
    declaredCommand: sanitized.command,
  });
  if (configuration.shape !== "agent-defined") throw new Error("The Manager definition must resolve to an aboard agent definition");
  return configuration;
}

/** `command` and `effort` are callbacks so a settings change applies to the next launch without reloading the window. */
export interface ManagerLifecycleOptions { readonly store: ManagerStore; readonly terminals: TerminalController; readonly workspaceRoot: string; readonly shell: ShellKind; readonly command?: () => readonly string[] | undefined; readonly effort?: () => EffortLevel | undefined; readonly definition?: (workspaceRoot: string) => Promise<ManagerLaunchDefinition>; readonly files: PromptSpillStore; readonly disallowedTools?: readonly string[]; readonly now?: () => Date; readonly agentIdFactory?: () => AgentId; readonly sessionIdFactory?: () => SessionId; readonly isResumable?: (sessionId: SessionId, cwd: string) => Promise<boolean>; readonly restoreTranscript?: (sessionId: SessionId) => Promise<unknown>; readonly preflight?: (command: readonly string[] | undefined) => Promise<void>; readonly wrapper?: SessionWrapperLayout; }
export class ManagerLifecycle {
  readonly #now: () => Date;
  public constructor(private readonly options: ManagerLifecycleOptions) { this.#now = options.now ?? (() => new Date()); }
  /** The caller chooses resume or new explicitly; there is no ambiguous "start" that has to ask. */
  public async start(mode: "resume" | "new"): Promise<TerminalSnapshot> {
    const prior = await this.options.store.load();
    if (mode === "resume" && !prior) throw new Error("No recorded Manager session exists");
    const agentId = mode === "resume" && prior ? prior.agentId : (this.options.agentIdFactory ?? (() => randomUUID() as AgentId))();
    const recorded = mode === "resume" && prior ? prior.sessionId : undefined;
    // Claude Code deletes session files older than `cleanupPeriodDays` at
    // startup and the sweep cannot be disabled, so the recorded transcript may
    // simply be gone. Put aboard's copy back first; the resumability check
    // below is what reads it, and a restore that fails or finds nothing just
    // leaves that check to answer "not resumable" as it always would.
    if (recorded !== undefined) await this.options.restoreTranscript?.(recorded);
    // --resume fails when the recorded session holds no conversation yet, which
    // a transcript file's existence does not rule out.
    const resumable = recorded !== undefined && await (this.options.isResumable ?? sessionIsResumable)(recorded, this.options.workspaceRoot);
    // An id that cannot be resumed cannot be reused either: Claude Code refuses
    // `--session-id` for any id that already has a transcript ("Session ID … is
    // already in use"), and an unresumable recorded session has one by
    // definition — that is why `--resume` rejected it. Relaunching under the
    // same id therefore fails both ways, so the recovery is a new conversation
    // under a new id. Nothing is lost: the id was refused precisely because it
    // holds no conversation, and Manager identity is the agent id, which is
    // stable across every restart.
    const sessionId = resumable && recorded !== undefined
      ? recorded
      : (this.options.sessionIdFactory ?? (() => randomUUID() as SessionId))();
    const launched = this.options.command?.();
    const command = launched === undefined ? {} : { command: launched };
    // The definition is read on both paths: a resume re-passes every flag the
    // launch did, because `--resume` restores the conversation and nothing else.
    const configuration = await (this.options.definition ?? readManagerLaunchDefinition)(this.options.workspaceRoot);
    // `aboard.launch.effort` is the session floor; the planner lets the
    // definition's own `effort:` win over it.
    const level = this.options.effort?.();
    const effort = level === undefined ? {} : { effort: level };
    const wrapper = this.options.wrapper === undefined ? {} : { wrapper: this.options.wrapper };
    const shared = { agentId, sessionId, shell: this.options.shell, configuration, disallowedTools: this.options.disallowedTools, ...command, ...effort, ...wrapper };
    const plan = resumable ? planManagerResume(shared) : planLaunch({ ...shared, agentType: "manager" });
    // Refuse a launch aboard already knows cannot run, rather than opening a
    // terminal that will only ever show a shell error. The plan is probed rather
    // than the setting because manager.md may declare its own `command:`, and
    // planning is pure — nothing has been created yet.
    await this.options.preflight?.(plan.command);
    // `--agent` names this file; a missing one is a refused launch rather than a
    // Manager on Claude Code's default persona.
    if (plan.agentDefinition !== undefined) await this.options.files.write(plan.agentDefinition);
    const terminal = this.options.terminals.create({ agentId, sessionId, agentType: "manager", name: "aboard: Manager", initialCommand: plan.commandLine, startupTimeoutMs: MANAGER_STARTUP_PROOF_TIMEOUT_MS });
    const updatedAt = this.#now().toISOString() as IsoTimestamp;
    await this.options.store.save({ version: 1, agentId, sessionId, terminalId: terminal.terminalId, updatedAt });
    return terminal;
  }
}
