import {
  buildChangeDirectoryCommandLine,
  type ShellKind,
} from "./shell.js";
import { randomUUID } from "node:crypto";
import { createBackgroundProcess } from "./background.js";

import {
  isInteractiveAgentType,
  type AgentId,
  type AgentPlatformId,
  type AgentType,
  type ExecutionMode,
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

export interface TerminalCreationOptions {
  readonly cwd: string;
  readonly provider?: AgentPlatformId;
  readonly name?: string;
  readonly shellPath?: string;
  readonly shellArgs?: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface TerminalHost {
  createTerminal(options: TerminalCreationOptions): TerminalHandle;
  createBackgroundProcess?(options: TerminalCreationOptions): TerminalHandle;
  onDidCloseTerminal(listener: (terminal: TerminalHandle) => void): { dispose(): void };
}

export interface BridgeTerminalEnvironment {
  readonly port: number;
  readonly token: string;
  readonly workspaceRoot: string;
  readonly runtimeRoot?: string;
}

export interface CreateAboardTerminalRequest {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly provider?: AgentPlatformId;
  readonly issueNumbers?: readonly number[];
  readonly name?: string;
  readonly cwd?: string;
  readonly shellPath?: string;
  readonly shellArgs?: readonly string[];
  readonly initialCommand?: string;
  /** Overrides the default focus behavior for bulk restoration. */
  readonly focus?: boolean;
  /** The user drives this session; reporting is configured independently. */
  readonly attended?: boolean;
  /** Harness needs this before the first provider hook can race the launch response. */
  readonly executionMode?: ExecutionMode;
  readonly harnessRequestId?: string;
  readonly completionCommitStartingSha?: string;
  readonly reviewRange?: string;
  readonly workerContinuation?: true;
  readonly startupTimeoutMs?: number;
  readonly providerEnvironment?: Readonly<Record<string, string>>;
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
  readonly backend?: "terminal" | "process";
  readonly terminalId: TerminalId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly issueNumbers?: readonly number[];
  readonly name: string;
  readonly cwd: string;
  readonly status: "open" | "detached" | "closed";
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly exitCode: number | null;
}

interface TerminalRecord extends Omit<TerminalSnapshot, "sessionId" | "status" | "closedAt" | "exitCode"> {
  sessionId: SessionId;
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

export interface StartupProofTracker {
  awaitStarted(agentId: AgentId, sessionId: SessionId, timeoutMs: number): Promise<unknown>;
  cancel(agentId: AgentId): void;
}

function isStartupTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "SessionStartTimeoutError";
}

export interface TerminalControllerOptions {
  readonly host: TerminalHost;
  readonly environment: () => BridgeTerminalEnvironment;
  readonly shell: ShellKind;
  readonly terminalIdFactory: () => TerminalId;
  readonly now?: () => Date;
  readonly onLifecycleEvent?: (event: TerminalLifecycleEvent) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly processIdTimeoutMs?: number;
  /** When set with `startupTimeoutMs` on a launch, arms the platform proof-of-life watch. */
  readonly startupProofs?: StartupProofTracker;
  readonly onStartupTimeout?: (agentId: AgentId, sessionId: SessionId, timeoutMs: number) => void;
}

function isUserFacing(request: CreateAboardTerminalRequest): boolean {
  return request.focus ?? (request.attended ?? isInteractiveAgentType(request.agentType));
}

export class TerminalController {
  readonly #records = new Map<TerminalId, TerminalRecord>();
  readonly #startupByAgent = new Map<AgentId, Promise<unknown>>();
  readonly #terminalIdsByHandle = new WeakMap<TerminalHandle, TerminalId>();
  readonly #closeRegistration: { dispose(): void };
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  public constructor(private readonly options: TerminalControllerOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#closeRegistration = options.host.onDidCloseTerminal((terminal) => this.#onClosed(terminal));
  }

  public create(
    request: CreateAboardTerminalRequest,
    beforeCommand?: (terminal: TerminalSnapshot) => void,
  ): TerminalSnapshot {
    return this.#create(request, beforeCommand);
  }

  #create(
    request: CreateAboardTerminalRequest,
    beforeCommand?: (terminal: TerminalSnapshot) => void,
  ): TerminalSnapshot {
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
    const cwd = request.cwd ?? environment.workspaceRoot;
    const env: Record<string, string> = {
      ABOARD_BRIDGE_PORT: String(environment.port),
      ABOARD_BRIDGE_TOKEN: environment.token,
      ABOARD_AGENT_ID: request.agentId,
      ABOARD_EXECUTION_ID: randomUUID(),
      ABOARD_SESSION_ID: request.sessionId,
      ABOARD_AGENT_TYPE: request.agentType,
      ABOARD_WORKSPACE_ROOT: cwd,
      ...(request.providerEnvironment ?? {}),
    };
    if (environment.runtimeRoot !== undefined) env.ABOARD_RUNTIME_ROOT = environment.runtimeRoot;
    if (request.issueNumbers !== undefined && request.issueNumbers.length > 0) {
      env.ABOARD_ISSUE_NUMBERS = request.issueNumbers.join(",");
    }
    if (request.attended === true) env.ABOARD_ATTENDED = "1";
    if (request.executionMode !== undefined) env.HARNESS_EXECUTION_MODE = request.executionMode;
    if (request.harnessRequestId !== undefined) env.HARNESS_REQUEST_ID = request.harnessRequestId;
    if (request.completionCommitStartingSha !== undefined) env.ABOARD_WORKER_START_SHA = request.completionCommitStartingSha;
    if (request.reviewRange !== undefined) env.ABOARD_REVIEW_RANGE = request.reviewRange;
    if (request.workerContinuation === true) env.ABOARD_WORKER_CONTINUATION = "1";

    const creationOptions: TerminalCreationOptions = {
      cwd,
      env,
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.shellPath === undefined ? {} : { shellPath: request.shellPath }),
      ...(request.shellArgs === undefined ? {} : { shellArgs: request.shellArgs }),
    };
    const headless = request.executionMode === "auto" || request.executionMode === "auto-run";
    const handle = headless
      ? this.options.host.createBackgroundProcess?.(creationOptions)
        ?? createBackgroundProcess(creationOptions, this.options.shell, (closed) => this.#onClosed(closed))
      : this.options.host.createTerminal(creationOptions);
    const createdAt = this.#now().toISOString();
    const record: TerminalRecord = {
      backend: headless ? "process" : "terminal",
      terminalId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      agentType: request.agentType,
      ...(request.issueNumbers === undefined ? {} : { issueNumbers: request.issueNumbers }),
      name,
      cwd,
      status: "open",
      createdAt,
      closedAt: null,
      exitCode: null,
      handle,
      killRequested: false,
    };
    this.#records.set(terminalId, record);
    this.#terminalIdsByHandle.set(handle, terminalId);

    // Arm proof before the command can emit SessionStart. Runtime-assigned
    // platforms also use beforeCommand to publish provisional ownership before
    // Codex can race its real session id back through the bridge.
    const startupTimeoutMs = request.startupTimeoutMs;
    if (startupTimeoutMs !== undefined && this.options.startupProofs !== undefined) {
      const startup = this.options.startupProofs.awaitStarted(request.agentId, request.sessionId, startupTimeoutMs);
      this.#startupByAgent.set(request.agentId, startup);
      void startup
        .then(undefined, (error: unknown) => {
          if (!isStartupTimeout(error)) return;
          const current = this.#records.get(terminalId);
          if (current === undefined || current.status !== "open") return;
          this.options.onStartupTimeout?.(request.agentId, request.sessionId, startupTimeoutMs);
          this.kill(terminalId);
        });
      void startup.then(
        () => this.#forgetStartup(request.agentId, startup),
        () => this.#forgetStartup(request.agentId, startup),
      );
    }

    this.options.onLifecycleEvent?.({
      type: "terminal-created",
      terminalId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      occurredAt: createdAt,
    });

    beforeCommand?.(this.#snapshot(record));

    if (!headless && isUserFacing(request)) handle.show(false);
    // VS Code receives cwd too; this visible belt-and-braces cd prevents a
    // shell that starts elsewhere from launching an agent against another tree.
    if (!headless) handle.sendText(buildChangeDirectoryCommandLine(this.options.shell, cwd), true);
    if (request.initialCommand !== undefined) handle.sendText(request.initialCommand, true);

    return this.#snapshot(record);
  }

  public list(): readonly TerminalSnapshot[] {
    return [...this.#records.values()].map((record) => this.#snapshot(record));
  }

  public liveTerminalForAgent(agentId: AgentId): TerminalId | undefined {
    const record = this.#latest((candidate) => candidate.agentId === agentId);
    return record?.status === "open" ? record.terminalId : undefined;
  }

  /** The proof armed by create(), shared with orchestration without rearming it. */
  public waitForStartup(agentId: AgentId): Promise<unknown> | undefined {
    return this.#startupByAgent.get(agentId);
  }

  public canBindSession(agentId: AgentId, expected: SessionId, actual: SessionId): boolean {
    const record = this.#latest((candidate) => candidate.agentId === agentId);
    if (record === undefined || record.status !== "open" || record.sessionId !== expected) return false;
    const owner = this.#latest((candidate) => candidate.sessionId === actual);
    return owner === undefined || owner.agentId === agentId;
  }

  /** Updates terminal-close ownership after a runtime-assigned session handshake. */
  public bindSession(agentId: AgentId, expected: SessionId, actual: SessionId): void {
    if (!this.canBindSession(agentId, expected, actual)) throw new Error("Terminal session identity does not match");
    this.#latest((candidate) => candidate.agentId === agentId)!.sessionId = actual;
  }

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
  // belongs in provider launch/resume arguments, never in terminal input.
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

  #forgetStartup(agentId: AgentId, startup: Promise<unknown>): void {
    if (this.#startupByAgent.get(agentId) === startup) this.#startupByAgent.delete(agentId);
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
