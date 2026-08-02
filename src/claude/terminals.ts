import {
  isInteractiveAgentType,
  type AgentId,
  type AgentType,
  type SessionId,
  type TerminalId,
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

/**
 * No `name`: aboard deliberately leaves the VS Code terminal with its default
 * shell name. An "aboard: manager" tab keeps that label after the session dies,
 * and a stale name that claims a live agent misleads worse than a generic one
 * informs. The aboard label lives on the fleet record instead, which is where
 * the user looks for agent state and which settles the moment the session does.
 */
export interface TerminalCreationOptions {
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
  /** Overrides the default focus behavior for bulk restoration. */
  readonly focus?: boolean;
  /**
   * Whether this session reports its result over the bridge. It is a property
   * of the launch, not of the type: the dual-mode builtin types
   * (`general-purpose`, `Explore`) report exactly when their launch is
   * result-delivering. The hooks read it as `ABOARD_DELIVERS_RESULT`, and its
   * absence means the session is handed to the user and stays hook-silent.
   */
  readonly deliversResult?: boolean;
  /**
   * Proof-of-life timeout: if the SessionStart hook has not reported the TUI's
   * process id within this many milliseconds, the launch failed (bad command,
   * CLI error printed and exited) and the terminal is killed so the normal
   * terminal-close settlement fires. Absent = no proof required (raw passthrough).
   */
  readonly startupTimeoutMs?: number;
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
  /**
   * `detached` means the Claude session died but the shell survived it: the VS
   * Code terminal may well still be open, and aboard has given it back to the
   * user. It is never killed, never controlled, and never blocks a relaunch.
   */
  readonly status: "open" | "detached" | "closed";
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

/**
 * Proof-of-life port implemented by the bridge's session-start tracker. The
 * controller owns the arming point — terminal creation is the one moment every
 * launch path (delegated workers, the Manager, PR resumes) passes through — so
 * a failed `claude` invocation (bad flag, missing binary) is detected even in
 * the window before the fleet registers the session.
 */
export interface StartupProofTracker {
  awaitStarted(agentId: AgentId, sessionId: SessionId, timeoutMs: number): Promise<unknown>;
  cancel(agentId: AgentId): void;
}

/**
 * Matched by name rather than by class: the proof tracker lives in the bridge
 * layer, which depends on this module and must not be imported back.
 */
function isStartupTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "SessionStartTimeoutError";
}

export interface TerminalControllerOptions {
  readonly host: TerminalHost;
  readonly environment: () => BridgeTerminalEnvironment;
  readonly terminalIdFactory: () => TerminalId;
  readonly now?: () => Date;
  readonly onLifecycleEvent?: (event: TerminalLifecycleEvent) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly processIdTimeoutMs?: number;
  /** When set with `startupTimeoutMs` on a launch, arms the proof-of-life watch. */
  readonly startupProofs?: StartupProofTracker;
  readonly onStartupTimeout?: (agentId: AgentId, sessionId: SessionId) => void;
}

/**
 * The Manager and every session handed to the user are shown on creation;
 * automated workers are not stolen focus for. Handed-to-the-user is per launch
 * (`deliversResult: false`), not only per type: a builtin type launched
 * interactively is shown exactly like an interactive-only one.
 */
function isUserFacing(request: CreateAboardTerminalRequest): boolean {
  return request.focus ?? (request.agentType === "manager" || isInteractiveAgentType(request.agentType) || request.deliversResult === false);
}

export class TerminalController {
  readonly #records = new Map<TerminalId, TerminalRecord>();
  readonly #terminalIdsByHandle = new WeakMap<TerminalHandle, TerminalId>();
  readonly #closeRegistration: { dispose(): void };
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  public constructor(private readonly options: TerminalControllerOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#closeRegistration = options.host.onDidCloseTerminal((terminal) => this.#onClosed(terminal));
  }

  /**
   * Opens a terminal for an agent. The invariants are that an agent and a
   * session each have at most one *live* terminal, and that a session id never
   * migrates to a different agent. A closed terminal is spent history: the same
    * agent may be launched again, which is what a Manager restart relies on.
   */
  public create(request: CreateAboardTerminalRequest): TerminalSnapshot {
    return this.#create(request);
  }

  #create(request: CreateAboardTerminalRequest): TerminalSnapshot {
    const latestForAgent = this.#latest((record) => record.agentId === request.agentId);
    if (latestForAgent?.status === "open") {
      throw new TerminalControlError("duplicate-agent", `Agent ${request.agentId} already has a live aboard terminal`);
    }
    const latestForSession = this.#latest((record) => record.sessionId === request.sessionId);
    if (latestForSession?.status === "open") {
      throw new TerminalControlError("duplicate-session", `Session ${request.sessionId} already has a live aboard terminal`);
    }
    if (latestForSession !== undefined && latestForSession.agentId !== request.agentId) {
      throw new TerminalControlError("duplicate-session", `Session ${request.sessionId} belongs to agent ${latestForSession.agentId}`);
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
    if (request.deliversResult === true) env.ABOARD_DELIVERS_RESULT = "1";

    const creationOptions: TerminalCreationOptions = {
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

    this.options.onLifecycleEvent?.({
      type: "terminal-created",
      terminalId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      occurredAt: createdAt,
    });

    if (isUserFacing(request)) handle.show(false);
    if (request.initialCommand !== undefined) handle.sendText(request.initialCommand, true);

    // Startup security pass: a failed launch (bad flag, missing binary) exits
    // before the TUI writes a transcript and produces no SessionStart hook, so
    // the absence of proof within the timeout is the failure signal itself.
    // The terminal is killed, which routes every settlement through the same
    // terminal-close path a user kill would take.
    if (request.startupTimeoutMs !== undefined && this.options.startupProofs !== undefined) {
      void this.options.startupProofs.awaitStarted(request.agentId, request.sessionId, request.startupTimeoutMs)
        .then(undefined, (error: unknown) => {
          // Only the timeout is a verdict. A cancellation means something else
          // already settled this launch — a closed terminal, or a CLI that
          // exited and was diagnosed from its exit record — and that path has
          // decided the terminal's fate, including leaving an error on screen.
          if (!isStartupTimeout(error)) return;
          const current = this.#records.get(terminalId);
          if (current === undefined || current.status !== "open") return;
          this.options.onStartupTimeout?.(request.agentId, request.sessionId);
          this.kill(terminalId);
        });
    }
    return this.#snapshot(record);
  }

  public list(): readonly TerminalSnapshot[] {
    return [...this.#records.values()].map((record) => this.#snapshot(record));
  }

  /**
   * The agent's open terminal, if any. Settlement paths need this *after* they
   * have dropped the fleet record, so the terminal id cannot be read back from
   * the fleet — and an uncollected terminal is exactly what makes the next
   * launch fail the one-live-terminal invariant.
   */
  public liveTerminalForAgent(agentId: AgentId): TerminalId | undefined {
    const record = this.#latest((candidate) => candidate.agentId === agentId);
    return record?.status === "open" ? record.terminalId : undefined;
  }

  /**
   * Hand the terminal back to the user without closing it. Used when a session
   * dies inside a surviving shell: the native handle is dropped, so a later
   * close emits no lifecycle event — by then the agent may have been relaunched
   * into a new terminal, and a stale close would settle the wrong session.
   */
  public release(terminalId: TerminalId): void {
    const record = this.#requireRecord(terminalId);
    if (record.status !== "open") return;
    record.status = "detached";
    if (record.handle !== undefined) this.#terminalIdsByHandle.delete(record.handle);
    record.handle = undefined;
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

  #latest(predicate: (record: TerminalRecord) => boolean): TerminalRecord | undefined {
    return [...this.#records.values()].reverse().find(predicate);
  }

  #requireRecord(terminalId: TerminalId): TerminalRecord {
    const record = this.#records.get(terminalId);
    if (record === undefined) throw new TerminalControlError("unknown-terminal", `Unknown terminal ${terminalId}`);
    return record;
  }

  #requireOpenHandle(terminalId: TerminalId): TerminalHandle {
    const record = this.#requireRecord(terminalId);
    if (record.status !== "open" || record.handle === undefined) {
      throw new TerminalControlError("closed-terminal", `Terminal ${terminalId} is ${record.status === "detached" ? "detached" : "closed"}`);
    }
    return record.handle;
  }

  #snapshot(record: TerminalRecord): TerminalSnapshot {
    const { handle: _handle, killRequested: _killRequested, ...snapshot } = record;
    return snapshot;
  }
}
