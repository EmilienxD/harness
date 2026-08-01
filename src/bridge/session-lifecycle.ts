import type { AgentId, SessionId } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import { protocolError, type BridgeRequestHandler } from "./protocol.js";

/**
 * Liveness for aboard sessions. Terminal-close used to be the only death
 * signal: it catches a killed terminal, but not the user closing the TUI from
 * inside (`exit`, double Ctrl+C) while the shell underneath lives on — those
 * left a zombie fleet entry holding the write lease. Every launch now goes
 * through aboard's wrapper, which owns a lock-marker file for exactly the
 * Claude child's lifetime, and this monitor polls the marker's existence.
 * Marker removal and terminal-close settle identically; `/clear` fires
 * SessionEnd while the process (and marker) stay alive, so it is handled as a
 * graceful conversation end instead.
 */
export type LockMarkerProbe = (lockFile: string) => boolean;

export interface SessionRegistration {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  /** Marker path owned by the launch wrapper; removed when the Claude child exits. */
  readonly lockFile: string;
}

export interface SessionStartObservation {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly source?: string;
}

export const SESSION_END_REASONS = [
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "bypass_permissions_disabled",
  "other",
] as const;

export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export interface SessionEndObservation {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly reason: SessionEndReason;
}

export interface ProcessEndedObservation {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly lockFile: string;
}

export interface SessionProcessMonitorOptions {
  readonly probe: LockMarkerProbe;
  /** Injected timers keep tests deterministic and deactivation explicit. */
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly onProcessEnded?: (observation: ProcessEndedObservation) => void;
  /** TEMP E2E instrumentation: per-sweep trace of tracked markers and probe results. */
  readonly debug?: (message: string) => void;
}

export class SessionProcessMonitor {
  readonly #options: SessionProcessMonitorOptions;
  readonly #watched = new Map<AgentId, SessionRegistration>();
  #timer: unknown;

  public constructor(options: SessionProcessMonitorOptions) {
    this.#options = options;
  }

  public start(intervalMs: number): void {
    this.stop();
    const set = this.#options.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
    this.#timer = set(() => this.poll(), intervalMs);
    // The poll timer must not keep the process alive on deactivation.
    if (typeof this.#timer === "object" && this.#timer !== null && "unref" in this.#timer) {
      (this.#timer as { unref(): void }).unref();
    }
  }

  public stop(): void {
    if (this.#timer === undefined) return;
    const clear = this.#options.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
    clear(this.#timer);
    this.#timer = undefined;
  }

  public track(registration: SessionRegistration): void {
    this.#options.debug?.(`track agent=${registration.agentId} lock=${registration.lockFile}`);
    this.#watched.set(registration.agentId, registration);
  }

  /** Forget the agent without reporting a death (settlement already happened). */
  public untrack(agentId: AgentId): void {
    this.#watched.delete(agentId);
  }

  public registration(agentId: AgentId): SessionRegistration | undefined {
    return this.#watched.get(agentId);
  }

  public isTracked(agentId: AgentId): boolean {
    return this.#watched.has(agentId);
  }

  /**
   * Liveness observation for lease stale-recovery. "live" only while the
   * marker file exists; untracked agents (session not started, or settled)
   * report "missing" so a dead terminal cannot be masked by a hook that never
   * fired.
   */
  public observe(agentId: AgentId): "live" | "ended" | "missing" {
    const registration = this.#watched.get(agentId);
    if (registration === undefined) return "missing";
    return this.#options.probe(registration.lockFile) ? "live" : "missing";
  }

  /** One sweep; public so a terminal close can flush pending deaths eagerly. */
  public poll(): void {
    for (const registration of [...this.#watched.values()]) {
      const alive = this.#options.probe(registration.lockFile);
      this.#options.debug?.(`poll agent=${registration.agentId} lock=${registration.lockFile} alive=${alive}`);
      if (alive) continue;
      this.#watched.delete(registration.agentId);
      this.#options.onProcessEnded?.(registration);
    }
  }
}

export interface SessionEndSettlement {
  /**
   * Settle a conversation that ended while its process and terminal live on
   * (`/clear`). Releases the lease and removes the agent from the fleet; the
   * terminal itself is left to the user, who deliberately kept it.
   */
  settleCleared(agentId: AgentId): void;
}

export interface SessionLifecycleServiceOptions {
  readonly fleet: FleetRegistry;
  readonly monitor: SessionProcessMonitor;
  readonly settlement: SessionEndSettlement;
  /** The wrapper's marker path for an agent — launch-time state the hook knows nothing about. */
  readonly lockPathFor: (agentId: AgentId) => string;
  readonly onSessionStarted?: (observation: SessionStartObservation) => void;
}

export class SessionLifecycleService {
  public constructor(private readonly options: SessionLifecycleServiceOptions) {}

  /** SessionStart = proof-of-life: registers the wrapper's marker for polling. */
  public sessionStarted(observation: SessionStartObservation): boolean {
    const session = this.options.fleet.get(observation.agentId);
    if (session === undefined || session.sessionId !== observation.sessionId) return false;
    this.options.monitor.track({
      agentId: observation.agentId,
      sessionId: observation.sessionId,
      lockFile: this.options.lockPathFor(observation.agentId),
    });
    this.options.onSessionStarted?.(observation);
    return true;
  }

  /**
   * SessionEnd is a conversation-level event with a 1.5s hook budget, so this
   * must stay cheap. Only `clear` settles here: the process demonstrably lives
   * on (it fired the hook inside a kept-alive TUI), so PID polling will never
   * settle this conversation. Process-exit reasons (`prompt_input_exit`,
   * `logout`, ...) are left to the monitor's next poll, which settles them
   * exactly like a terminal close.
   */
  public sessionEnded(observation: SessionEndObservation): boolean {
    if (observation.reason !== "clear") return false;
    const session = this.options.fleet.get(observation.agentId);
    if (session === undefined || session.sessionId !== observation.sessionId) return false;
    if (session.lifecycle.status === "completed" || session.lifecycle.status === "failed") return false;
    this.options.monitor.untrack(observation.agentId);
    this.options.settlement.settleCleared(observation.agentId);
    return true;
  }
}

export interface SessionStartupProof {
  /** Resolves when SessionStart reports the session live; rejects on timeout. */
  awaitStarted(agentId: AgentId, sessionId: SessionId, timeoutMs: number): Promise<SessionStartObservation>;
  cancel(agentId: AgentId): void;
  /** Called by the session-start route; returns false for stale/unknown ids. */
  discharge(observation: SessionStartObservation): boolean;
}

interface PendingProof {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  resolve(registration: SessionStartObservation): void;
  reject(error: Error): void;
  timer: unknown;
}

/**
 * Startup security pass. The extension types the launch command into a shell
 * it does not own, so a CLI failure (unknown flag, missing binary, auth wall)
 * exits before any TUI exists and the terminal-close signal cannot tell a slow
 * start from a failed one. The SessionStart hook is the first signal that only
 * a live TUI can produce, so each launch arms a timeout here and the
 * session-start route discharges it.
 */
export class SessionStartupProofs implements SessionStartupProof {
  readonly #pending = new Map<AgentId, PendingProof>();
  readonly #setTimeout: (callback: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;

  public constructor(options?: {
    readonly setTimeout?: (callback: () => void, ms: number) => unknown;
    readonly clearTimeout?: (handle: unknown) => void;
  }) {
    this.#setTimeout = options?.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimeout = options?.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  public awaitStarted(agentId: AgentId, sessionId: SessionId, timeoutMs: number): Promise<SessionStartObservation> {
    this.cancel(agentId);
    return new Promise<SessionStartObservation>((resolve, reject) => {
      const pending: PendingProof = {
        agentId,
        sessionId,
        resolve: (registration) => {
          this.#clear(pending);
          resolve(registration);
        },
        reject: (error) => {
          this.#clear(pending);
          reject(error);
        },
        timer: undefined,
      };
      pending.timer = this.#setTimeout(() => {
        pending.reject(new SessionStartTimeoutError(agentId, timeoutMs));
      }, timeoutMs);
      this.#pending.set(agentId, pending);
    });
  }

  /** Called by the session-start route; returns false for stale/unknown ids. */
  public discharge(observation: SessionStartObservation): boolean {
    const pending = this.#pending.get(observation.agentId);
    if (pending === undefined || pending.sessionId !== observation.sessionId) return false;
    pending.resolve(observation);
    return true;
  }

  public cancel(agentId: AgentId): void {
    const pending = this.#pending.get(agentId);
    if (pending === undefined) return;
    this.#clear(pending);
    pending.reject(new SessionStartCancelledError(agentId));
  }

  #clear(pending: PendingProof): void {
    this.#clearTimeout(pending.timer);
    if (this.#pending.get(pending.agentId) === pending) this.#pending.delete(pending.agentId);
  }
}

export class SessionStartTimeoutError extends Error {
  public constructor(
    public readonly agentId: AgentId,
    public readonly timeoutMs: number,
  ) {
    super(`Claude session did not start within ${Math.round(timeoutMs / 1000)}s — no SessionStart hook fired. Check the terminal for a CLI error.`);
    this.name = "SessionStartTimeoutError";
  }
}

export class SessionStartCancelledError extends Error {
  public constructor(public readonly agentId: AgentId) {
    super(`Startup wait for agent ${agentId} was cancelled`);
    this.name = "SessionStartCancelledError";
  }
}

export interface SessionLifecycleRoutesOptions {
  readonly service: SessionLifecycleService;
  readonly proofs?: SessionStartupProof;
}

export function createSessionLifecycleRoutes(options: SessionLifecycleRoutesOptions): BridgeRequestHandler {
  return async (request) => {
    if (request.method !== "POST") return protocolError(404, "not-found", "Route not found");
    try {
      if (request.url.pathname === "/hooks/session-start") {
        const observation = parseSessionStart(request.body);
        const accepted = options.service.sessionStarted(observation);
        options.proofs?.discharge(observation);
        return { status: 200, body: { ok: true, accepted } };
      }
      if (request.url.pathname === "/hooks/session-end") {
        const observation = parseSessionEnd(request.body);
        return { status: 200, body: { ok: true, accepted: options.service.sessionEnded(observation) } };
      }
      return protocolError(404, "not-found", "Route not found");
    } catch (error) {
      return protocolError(400, "invalid-request", error instanceof Error ? error.message : "Invalid session lifecycle event");
    }
  };
}

function parseSessionStart(input: unknown): SessionStartObservation {
  const value = record(input);
  const source = optionalString(value.source);
  return {
    agentId: agentId(value.agentId),
    sessionId: sessionId(value.sessionId),
    ...(source === undefined ? {} : { source }),
  };
}

function parseSessionEnd(input: unknown): SessionEndObservation {
  const value = record(input);
  const reason = requiredString(value.reason, "reason") as SessionEndReason;
  if (!(SESSION_END_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`reason must be one of ${SESSION_END_REASONS.join(", ")}`);
  }
  return {
    agentId: agentId(value.agentId),
    sessionId: sessionId(value.sessionId),
    reason,
  };
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Request body must be an object");
  return input as Record<string, unknown>;
}
function requiredString(input: unknown, name: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return input;
}
function optionalString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}
function agentId(input: unknown): AgentId { return requiredString(input, "agentId") as AgentId; }
function sessionId(input: unknown): SessionId { return requiredString(input, "sessionId") as SessionId; }
