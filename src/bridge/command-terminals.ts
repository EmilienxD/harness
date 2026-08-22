/**
 * Plain command terminals: the bridge's one surface that is deliberately *not*
 * an agent.
 *
 * An automated script — a project's own setup command, a backend or frontend
 * bootstrap, a task runner living in another repository — asks the extension to
 * run a shell command, and the extension opens a real VS Code terminal for it so
 * the user watches the output where they watch everything else. Nothing here
 * registers a fleet member, takes the write lease, receives `ABOARD_*`
 * credentials, or resumes: a command terminal is an ordinary shell the user owns
 * from the moment it appears, and its whole lifecycle is the terminal's own.
 *
 * The terminal host types come from the Claude launch boundary because that is
 * where the abstraction over `window.createTerminal()` already lives; this
 * module uses only that abstraction and knows nothing about Claude Code.
 */

import type { TerminalHandle, TerminalHost } from "../claude/terminals.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";

export type CommandTerminalId = string & { readonly __brand: "CommandTerminalId" };

export interface RunCommandRequest {
  /** A single shell command line, sent to the terminal exactly as given. */
  readonly command: string;
  /** Terminal tab label. Defaults to a generic aboard label. */
  readonly name?: string;
  readonly cwd?: string;
  /** Extra environment on top of the one VS Code gives its terminals. */
  readonly env?: Readonly<Record<string, string>>;
  /** Reveal the terminal. Defaults to true: visible output is the point. */
  readonly show?: boolean;
}

export interface CommandTerminalSnapshot {
  readonly commandTerminalId: CommandTerminalId;
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: "open" | "closed";
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly exitCode: number | null;
}

interface CommandTerminalRecord extends Omit<CommandTerminalSnapshot, "status" | "closedAt" | "exitCode"> {
  status: CommandTerminalSnapshot["status"];
  closedAt: string | null;
  exitCode: number | null;
  handle: TerminalHandle | undefined;
}

export type CommandTerminalErrorCode = "unknown-terminal" | "closed-terminal" | "unusable-cwd";

export class CommandTerminalError extends Error {
  public constructor(
    public readonly code: CommandTerminalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CommandTerminalServiceOptions {
  readonly host: TerminalHost;
  /** Where a request that names no directory runs: the workspace root. */
  readonly defaultCwd: () => string;
  readonly idFactory: () => CommandTerminalId;
  readonly now?: () => Date;
  /**
   * Rejects a directory that does not exist. A caller here is a script with no
   * eyes on the screen, so a bad path has to come back as a failed request
   * rather than as a terminal that flashes a shell error and sits there.
   */
  readonly directoryExists?: (path: string) => boolean;
}

export class CommandTerminalService {
  readonly #records = new Map<CommandTerminalId, CommandTerminalRecord>();
  readonly #idsByHandle = new WeakMap<TerminalHandle, CommandTerminalId>();
  readonly #closeRegistration: { dispose(): void };
  readonly #now: () => Date;

  public constructor(private readonly options: CommandTerminalServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#closeRegistration = options.host.onDidCloseTerminal((terminal) => this.#onClosed(terminal));
  }

  public run(request: RunCommandRequest): CommandTerminalSnapshot {
    const cwd = request.cwd ?? this.options.defaultCwd();
    if (this.options.directoryExists?.(cwd) === false) {
      throw new CommandTerminalError("unusable-cwd", `Directory ${cwd} does not exist`);
    }
    const commandTerminalId = this.options.idFactory();
    const name = request.name ?? "aboard: command";
    const handle = this.options.host.createTerminal({
      cwd,
      name,
      // No bridge port, token, or agent identity: a command terminal is not an
      // aboard agent and must not be able to act as one.
      env: { ...request.env },
    });
    const record: CommandTerminalRecord = {
      commandTerminalId,
      name,
      command: request.command,
      cwd,
      status: "open",
      createdAt: this.#now().toISOString(),
      closedAt: null,
      exitCode: null,
      handle,
    };
    this.#records.set(commandTerminalId, record);
    this.#idsByHandle.set(handle, commandTerminalId);

    if (request.show ?? true) handle.show(false);
    handle.sendText(request.command, true);
    return snapshot(record);
  }

  public list(): readonly CommandTerminalSnapshot[] {
    return [...this.#records.values()].map(snapshot);
  }

  public get(commandTerminalId: CommandTerminalId): CommandTerminalSnapshot {
    return snapshot(this.#require(commandTerminalId));
  }

  public show(commandTerminalId: CommandTerminalId): void {
    this.#requireOpenHandle(commandTerminalId).show(false);
  }

  public kill(commandTerminalId: CommandTerminalId): void {
    this.#requireOpenHandle(commandTerminalId).dispose();
  }

  public dispose(): void {
    this.#closeRegistration.dispose();
  }

  #onClosed(handle: TerminalHandle): void {
    const commandTerminalId = this.#idsByHandle.get(handle);
    if (commandTerminalId === undefined) return;
    this.#idsByHandle.delete(handle);
    const record = this.#records.get(commandTerminalId);
    if (record === undefined || record.status === "closed") return;
    record.status = "closed";
    record.closedAt = this.#now().toISOString();
    record.exitCode = handle.exitStatus?.code ?? null;
    record.handle = undefined;
  }

  #require(commandTerminalId: CommandTerminalId): CommandTerminalRecord {
    const record = this.#records.get(commandTerminalId);
    if (record === undefined) throw new CommandTerminalError("unknown-terminal", `Unknown command terminal ${commandTerminalId}`);
    return record;
  }

  #requireOpenHandle(commandTerminalId: CommandTerminalId): TerminalHandle {
    const record = this.#require(commandTerminalId);
    if (record.status !== "open" || record.handle === undefined) {
      throw new CommandTerminalError("closed-terminal", `Command terminal ${commandTerminalId} is closed`);
    }
    return record.handle;
  }
}

function snapshot(record: CommandTerminalRecord): CommandTerminalSnapshot {
  const { handle: _handle, ...rest } = record;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): BridgeResponse {
  return protocolError(400, "invalid-request", message);
}

/**
 * A terminal receives one line, so a newline in either the command or the tab
 * label is unrepresentable rather than escapable — the same rule the Claude
 * launch command lines follow. A caller that wants several steps chains them
 * with its own shell's operator.
 */
const CONTROL_CHARACTERS = /[\p{Cc}]/u;

function parseRun(body: unknown): RunCommandRequest | BridgeResponse {
  if (!isRecord(body)) return invalid("Request body must be an object");
  const { command, name, cwd, env, show } = body;
  if (typeof command !== "string" || command.trim() === "") return invalid("command must be a non-empty string");
  if (CONTROL_CHARACTERS.test(command)) return invalid("command must be a single line without control characters");
  for (const [field, value] of [["name", name], ["cwd", cwd]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") return invalid(`${field} must be a non-empty string`);
    if (CONTROL_CHARACTERS.test(value)) return invalid(`${field} must not contain control characters`);
  }
  if (show !== undefined && typeof show !== "boolean") return invalid("show must be a boolean");
  if (env !== undefined) {
    if (!isRecord(env)) return invalid("env must be an object of string values");
    for (const [key, value] of Object.entries(env)) {
      if (key.trim() === "" || typeof value !== "string") return invalid("env must map non-empty names to string values");
    }
  }
  return {
    command,
    ...(name === undefined ? {} : { name: name as string }),
    ...(cwd === undefined ? {} : { cwd: cwd as string }),
    ...(env === undefined ? {} : { env: env as Record<string, string> }),
    ...(show === undefined ? {} : { show: show as boolean }),
  };
}

function commandError(error: unknown): BridgeResponse {
  if (!(error instanceof CommandTerminalError)) throw error;
  if (error.code === "unknown-terminal") return protocolError(404, "not-found", error.message);
  if (error.code === "unusable-cwd") return protocolError(400, "invalid-request", error.message);
  return protocolError(409, "terminal-closed", error.message);
}

export function createCommandRoutes(commands: CommandTerminalService): BridgeRequestHandler {
  return (request) => {
    const parts = request.url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "commands") return protocolError(404, "not-found", "Route not found");
    try {
      if (request.method === "POST" && parts.length === 1) {
        const parsed = parseRun(request.body);
        if ("status" in parsed) return parsed;
        return { status: 201, body: commands.run(parsed) };
      }
      if (request.method === "GET" && parts.length === 1) return { status: 200, body: { commandTerminals: commands.list() } };
      if (parts.length < 2) return protocolError(404, "not-found", "Route not found");
      const commandTerminalId = parts[1] as CommandTerminalId;
      if (request.method === "GET" && parts.length === 2) return { status: 200, body: commands.get(commandTerminalId) };
      if (request.method === "POST" && parts.length === 3 && parts[2] === "show") {
        commands.show(commandTerminalId);
        return { status: 200, body: { ok: true } };
      }
      if (request.method === "DELETE" && parts.length === 2) {
        commands.kill(commandTerminalId);
        return { status: 200, body: { ok: true } };
      }
      return protocolError(404, "not-found", "Route not found");
    } catch (error) {
      return commandError(error);
    }
  };
}
