import type {
  AgentId,
  AgentType,
  SessionId,
  TerminalId,
} from "../domain/contracts.js";

export const TERMINAL_KEYS = [
  "enter",
  "return",
  "escape",
  "esc",
  "tab",
  "backspace",
  "space",
  "up",
  "down",
  "right",
  "left",
  "ctrl-c",
  "ctrl-d",
  "ctrl-u",
  "ctrl-l",
] as const;

export type TerminalKey = (typeof TERMINAL_KEYS)[number];

const KEY_SEQUENCES: Readonly<Record<TerminalKey, string>> = {
  enter: "\r",
  return: "\r",
  escape: "\u001b",
  esc: "\u001b",
  tab: "\t",
  backspace: "\u007f",
  space: " ",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  "ctrl-c": "\u0003",
  "ctrl-d": "\u0004",
  "ctrl-u": "\u0015",
  "ctrl-l": "\u000c",
};

export interface TerminalHandle {
  readonly processId: PromiseLike<number | undefined>;
  readonly exitStatus: { readonly code: number | undefined } | undefined;
  sendText(text: string, addNewLine?: boolean): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface TerminalCreationOptions {
  readonly name: string;
  readonly cwd: string;
  readonly shellPath?: string;
  readonly shellArgs?: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface TerminalHost {
  createTerminal(options: TerminalCreationOptions): TerminalHandle;
  onDidCloseTerminal(listener: (terminal: TerminalHandle) => void): { dispose(): void };
}

export interface BridgeTerminalEnvironment {
  readonly port: number;
  readonly token: string;
  readonly workspaceRoot: string;
}

export interface CreateAboardTerminalRequest {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly issueNumber?: number;
  readonly name?: string;
  readonly shellPath?: string;
  readonly shellArgs?: readonly string[];
  readonly initialCommand?: string;
}

export type TerminalLifecycleEvent =
  | {
      readonly type: "terminal-created";
      readonly terminalId: TerminalId;
      readonly agentId: AgentId;
      readonly sessionId: SessionId;
      readonly occurredAt: string;
    }
  | {
      readonly type: "terminal-closed";
      readonly terminalId: TerminalId;
      readonly agentId: AgentId;
      readonly sessionId: SessionId;
      readonly exitCode: number | null;
      readonly reason: "exited" | "killed";
      readonly occurredAt: string;
    };

export interface TerminalSnapshot {
  readonly terminalId: TerminalId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly issueNumber?: number;
  readonly name: string;
  readonly cwd: string;
  readonly status: "open" | "closed";
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly exitCode: number | null;
}

interface TerminalRecord extends Omit<TerminalSnapshot, "status" | "closedAt" | "exitCode"> {
  status: TerminalSnapshot["status"];
  closedAt: string | null;
  exitCode: number | null;
  handle: TerminalHandle | undefined;
  killRequested: boolean;
}

export type TerminalControlErrorCode =
  | "duplicate-agent"
  | "duplicate-session"
  | "unknown-terminal"
  | "closed-terminal";

export class TerminalControlError extends Error {
  public constructor(
    public readonly code: TerminalControlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface TerminalControllerOptions {
  readonly host: TerminalHost;
  readonly environment: () => BridgeTerminalEnvironment;
  readonly terminalIdFactory: () => TerminalId;
  readonly now?: () => Date;
  readonly onLifecycleEvent?: (event: TerminalLifecycleEvent) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly processIdTimeoutMs?: number;
}

const INTERACTIVE_AGENT_TYPES: ReadonlySet<AgentType> = new Set([
  "manager",
  "brainstormer",
  "raw",
]);

export class TerminalController {
  readonly #records = new Map<TerminalId, TerminalRecord>();
  readonly #terminalIdsByHandle = new WeakMap<TerminalHandle, TerminalId>();
  readonly #agentIds = new Set<AgentId>();
  readonly #sessionIds = new Set<SessionId>();
  readonly #closeRegistration: { dispose(): void };
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  public constructor(private readonly options: TerminalControllerOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#closeRegistration = options.host.onDidCloseTerminal((terminal) => this.#onClosed(terminal));
  }

  public create(request: CreateAboardTerminalRequest): TerminalSnapshot {
    if (this.#agentIds.has(request.agentId)) {
      throw new TerminalControlError("duplicate-agent", `Agent ${request.agentId} already has an aboard terminal`);
    }
    if (this.#sessionIds.has(request.sessionId)) {
      throw new TerminalControlError("duplicate-session", `Session ${request.sessionId} already has an aboard terminal`);
    }

    const environment = this.options.environment();
    const terminalId = this.options.terminalIdFactory();
    const name = request.name ?? `aboard: ${request.agentType}`;
    const env: Record<string, string> = {
      ABOARD_BRIDGE_PORT: String(environment.port),
      ABOARD_BRIDGE_TOKEN: environment.token,
      ABOARD_AGENT_ID: request.agentId,
      ABOARD_SESSION_ID: request.sessionId,
      ABOARD_AGENT_TYPE: request.agentType,
      ABOARD_WORKSPACE_ROOT: environment.workspaceRoot,
    };
    if (request.issueNumber !== undefined) env.ABOARD_ISSUE_NUMBER = String(request.issueNumber);

    const creationOptions: TerminalCreationOptions = {
      name,
      cwd: environment.workspaceRoot,
      env,
      ...(request.shellPath === undefined ? {} : { shellPath: request.shellPath }),
      ...(request.shellArgs === undefined ? {} : { shellArgs: request.shellArgs }),
    };
    const handle = this.options.host.createTerminal(creationOptions);
    const createdAt = this.#now().toISOString();
    const record: TerminalRecord = {
      terminalId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      agentType: request.agentType,
      ...(request.issueNumber === undefined ? {} : { issueNumber: request.issueNumber }),
      name,
      cwd: environment.workspaceRoot,
      status: "open",
      createdAt,
      closedAt: null,
      exitCode: null,
      handle,
      killRequested: false,
    };
    this.#records.set(terminalId, record);
    this.#terminalIdsByHandle.set(handle, terminalId);
    this.#agentIds.add(request.agentId);
    this.#sessionIds.add(request.sessionId);

    this.options.onLifecycleEvent?.({
      type: "terminal-created",
      terminalId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      occurredAt: createdAt,
    });

    if (INTERACTIVE_AGENT_TYPES.has(request.agentType)) handle.show(false);
    if (request.initialCommand !== undefined) handle.sendText(request.initialCommand, true);
    return this.#snapshot(record);
  }

  public list(): readonly TerminalSnapshot[] {
    return [...this.#records.values()].map((record) => this.#snapshot(record));
  }

  public get(terminalId: TerminalId): TerminalSnapshot {
    return this.#snapshot(this.#requireRecord(terminalId));
  }

  public async getWithProcessId(terminalId: TerminalId): Promise<TerminalSnapshot & { readonly processId: number | null }> {
    const record = this.#requireRecord(terminalId);
    const handle = record.handle;
    if (handle === undefined) return { ...this.#snapshot(record), processId: null };
    const timeout = this.options.processIdTimeoutMs ?? 250;
    let processId: number | undefined;
    try {
      processId = await Promise.race([
        Promise.resolve(handle.processId),
        this.#sleep(timeout).then(() => undefined),
      ]);
    } catch {
      processId = undefined;
    }
    return { ...this.#snapshot(record), processId: processId ?? null };
  }

  public show(terminalId: TerminalId): void {
    this.#requireOpenHandle(terminalId).show(false);
  }

  public kill(terminalId: TerminalId): void {
    const record = this.#requireRecord(terminalId);
    const handle = this.#requireOpenHandle(terminalId);
    record.killRequested = true;
    handle.dispose();
  }

  // These methods are intentionally takeover-specific. Automated prompt delivery
  // belongs in Claude launch/resume arguments, never in terminal input.
  public sendUserTakeoverText(terminalId: TerminalId, text: string, addNewLine = true): void {
    this.#requireOpenHandle(terminalId).sendText(text, addNewLine);
  }

  public async sendUserTakeoverKeys(
    terminalId: TerminalId,
    keys: readonly TerminalKey[],
    delayMs = 30,
  ): Promise<void> {
    const handle = this.#requireOpenHandle(terminalId);
    for (const [index, key] of keys.entries()) {
      handle.sendText(KEY_SEQUENCES[key], false);
      if (delayMs > 0 && index < keys.length - 1) await this.#sleep(delayMs);
    }
  }

  public dispose(): void {
    this.#closeRegistration.dispose();
  }

  #onClosed(handle: TerminalHandle): void {
    const terminalId = this.#terminalIdsByHandle.get(handle);
    if (terminalId === undefined) return;
    this.#terminalIdsByHandle.delete(handle);
    const record = this.#records.get(terminalId);
    if (record === undefined || record.status === "closed") return;
    const closedAt = this.#now().toISOString();
    const exitCode = handle.exitStatus?.code ?? null;
    record.status = "closed";
    record.closedAt = closedAt;
    record.exitCode = exitCode;
    record.handle = undefined;
    this.options.onLifecycleEvent?.({
      type: "terminal-closed",
      terminalId,
      agentId: record.agentId,
      sessionId: record.sessionId,
      exitCode,
      reason: record.killRequested ? "killed" : "exited",
      occurredAt: closedAt,
    });
  }

  #requireRecord(terminalId: TerminalId): TerminalRecord {
    const record = this.#records.get(terminalId);
    if (record === undefined) throw new TerminalControlError("unknown-terminal", `Unknown terminal ${terminalId}`);
    return record;
  }

  #requireOpenHandle(terminalId: TerminalId): TerminalHandle {
    const record = this.#requireRecord(terminalId);
    if (record.status === "closed" || record.handle === undefined) {
      throw new TerminalControlError("closed-terminal", `Terminal ${terminalId} is closed`);
    }
    return record.handle;
  }

  #snapshot(record: TerminalRecord): TerminalSnapshot {
    const { handle: _handle, killRequested: _killRequested, ...snapshot } = record;
    return snapshot;
  }
}
