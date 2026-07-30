import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ManagerPersistenceDto, AgentId, SessionId, TerminalId, IsoTimestamp } from "../domain/contracts.js";
import { parseManagerPersistenceDto } from "../domain/validation.js";
import { MANAGER_TOOL_PRESET_TOOLS, type ManagerToolPreset, planLaunch, planManagerResume } from "./launch.js";
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

export interface ManagerLifecycleOptions { readonly store: ManagerStore; readonly terminals: TerminalController; readonly workspaceRoot: string; readonly shell: ShellKind; readonly executable?: string; readonly preset: ManagerToolPreset; readonly disallowedTools?: readonly string[]; readonly now?: () => Date; readonly agentIdFactory?: () => AgentId; readonly sessionIdFactory?: () => SessionId; }
export class ManagerLifecycle {
  readonly #now: () => Date;
  public constructor(private readonly options: ManagerLifecycleOptions) { this.#now = options.now ?? (() => new Date()); }
  public async start(mode: "start" | "resume" | "new" = "start"): Promise<TerminalSnapshot> {
    const prior = await this.options.store.load();
    if (mode === "start" && prior) throw new Error("A Manager session is recorded; use Resume Manager or New Manager");
    const agentId = mode === "resume" && prior ? prior.agentId : (this.options.agentIdFactory ?? (() => randomUUID() as AgentId))();
    const sessionId = mode === "resume" && prior ? prior.sessionId : (this.options.sessionIdFactory ?? (() => randomUUID() as SessionId))();
    if (mode === "resume" && !prior) throw new Error("No recorded Manager session exists");
    const plan = mode === "resume" ? planManagerResume({ agentId, sessionId, shell: this.options.shell, ...(this.options.executable === undefined ? {} : { executable: this.options.executable }) }) : planLaunch({ agentId, sessionId, agentType: "manager", shell: this.options.shell, permissionMode: "default", configuration: { shape: "inline", tools: MANAGER_TOOL_PRESET_TOOLS[this.options.preset] }, disallowedTools: this.options.disallowedTools, ...(this.options.executable === undefined ? {} : { executable: this.options.executable }) });
    const terminal = mode === "resume" && prior ? this.options.terminals.resume({ agentId, sessionId, agentType: "manager", name: "aboard: Manager", initialCommand: plan.commandLine }) : this.options.terminals.create({ agentId, sessionId, agentType: "manager", name: "aboard: Manager", initialCommand: plan.commandLine });
    const updatedAt = this.#now().toISOString() as IsoTimestamp;
    await this.options.store.save({ version: 1, agentId, sessionId, terminalId: terminal.terminalId, updatedAt });
    return terminal;
  }
}
