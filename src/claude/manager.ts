import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ManagerPersistenceDto, AgentId, SessionId, TerminalId, IsoTimestamp } from "../domain/contracts.js";
import { parseManagerPersistenceDto } from "../domain/validation.js";
import { managerLaunchConfiguration, type ManagerToolPreset, type WorkerPermissionMode, planLaunch, planManagerResume } from "./launch.js";
import { sessionTranscriptExists } from "./sessions.js";
import type { ShellKind } from "./shell.js";
import type { TerminalController, TerminalSnapshot } from "./terminals.js";

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

/** `command` and `permissionMode` are callbacks so a settings change applies to the next launch without reloading the window. */
export interface ManagerLifecycleOptions { readonly store: ManagerStore; readonly terminals: TerminalController; readonly workspaceRoot: string; readonly shell: ShellKind; readonly command?: () => readonly string[] | undefined; readonly permissionMode?: () => WorkerPermissionMode; readonly preset: ManagerToolPreset; readonly disallowedTools?: readonly string[]; readonly now?: () => Date; readonly agentIdFactory?: () => AgentId; readonly sessionIdFactory?: () => SessionId; readonly transcriptExists?: (sessionId: SessionId, cwd: string) => Promise<boolean>; }
export class ManagerLifecycle {
  readonly #now: () => Date;
  public constructor(private readonly options: ManagerLifecycleOptions) { this.#now = options.now ?? (() => new Date()); }
  /** The caller chooses resume or new explicitly; there is no ambiguous "start" that has to ask. */
  public async start(mode: "resume" | "new"): Promise<TerminalSnapshot> {
    const prior = await this.options.store.load();
    if (mode === "resume" && !prior) throw new Error("No recorded Manager session exists");
    const agentId = mode === "resume" && prior ? prior.agentId : (this.options.agentIdFactory ?? (() => randomUUID() as AgentId))();
    const sessionId = mode === "resume" && prior ? prior.sessionId : (this.options.sessionIdFactory ?? (() => randomUUID() as SessionId))();
    // --resume fails when the recorded session was closed before its first
    // message: no transcript exists yet. Recover by starting the conversation
    // afresh under the same imposed id (--session-id); identity and history
    // continuity are preserved because the id never changes.
    const resumable = mode === "resume" && await (this.options.transcriptExists ?? sessionTranscriptExists)(sessionId, this.options.workspaceRoot);
    const launched = this.options.command?.();
    const command = launched === undefined ? {} : { command: launched };
    const permissionMode = this.options.permissionMode?.() ?? "default";
    const plan = resumable
      ? planManagerResume({ agentId, sessionId, shell: this.options.shell, permissionMode, ...command })
      : planLaunch({ agentId, sessionId, agentType: "manager", shell: this.options.shell, permissionMode, configuration: managerLaunchConfiguration(this.options.preset), disallowedTools: this.options.disallowedTools, ...command });
    const terminal = this.options.terminals.create({ agentId, sessionId, agentType: "manager", name: "aboard: Manager", initialCommand: plan.commandLine });
    const updatedAt = this.#now().toISOString() as IsoTimestamp;
    await this.options.store.save({ version: 1, agentId, sessionId, terminalId: terminal.terminalId, updatedAt });
    return terminal;
  }
}
