import type { AgentId, SessionId } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import { protocolError, type BridgeRequestHandler } from "./protocol.js";

export type LockMarkerProbe = (lockFile: string) => boolean;

export interface SessionRegistration {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  /** Marker path owned by the launch wrapper; removed when the agent child exits. */
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

export type SessionEndPhase = "launching" | "live";

export interface ProcessEndedObservation {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly lockFile: string;
  readonly phase: SessionEndPhase;
}

export interface SessionProcessMonitorOptions {
  readonly probe: LockMarkerProbe;
  /** Injected timers keep tests deterministic and deactivation explicit. */
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly onProcessEnded?: (observation: ProcessEndedObservation) => void;
  /** Trace of tracking changes and observed deaths; never per-sweep, which would flood the log. */
  readonly debug?: (message: string) => void;
}

const EXIT_CONFIRMATION_DELAYS_MS = [50, 150, 400, 1_000, 2_500] as const;

interface WatchedSession {
  readonly registration: SessionRegistration;
  /** A SessionStart hook has proved a TUI exists. */
  proven: boolean;
  /** The wrapper's marker has been observed at least once. */
  appeared: boolean;
}

export class SessionProcessMonitor {
  readonly #options: SessionProcessMonitorOptions;
  readonly #watched = new Map<AgentId, WatchedSession>();
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

  public trackLaunch(registration: SessionRegistration): void {
    this.#options.debug?.(`launch agent=${registration.agentId} lock=${registration.lockFile}`);
    this.#watched.set(registration.agentId, { registration, proven: false, appeared: false });
  }

  /** Promote a launch to a proven session, or start watching one directly. */
  public track(registration: SessionRegistration): void {
    this.#options.debug?.(`track agent=${registration.agentId} lock=${registration.lockFile}`);
    const existing = this.#watched.get(registration.agentId);
    this.#watched.set(registration.agentId, {
      registration,
      proven: true,
      appeared: existing?.appeared ?? false,
    });
  }

  /** Forget the agent without reporting a death (settlement already happened). */
  public untrack(agentId: AgentId): void {
    this.#watched.delete(agentId);
  }

  public registration(agentId: AgentId): SessionRegistration | undefined {
    return this.#watched.get(agentId)?.registration;
  }

  public isTracked(agentId: AgentId): boolean {
    return this.#watched.has(agentId);
  }

  public observe(agentId: AgentId): "live" | "ended" | "missing" {
    const watched = this.#watched.get(agentId);
    if (watched === undefined || !watched.proven) return "missing";
    return this.#options.probe(watched.registration.lockFile) ? "live" : "missing";
  }

  /** One sweep; public so a marker watch or terminal close can flush deaths eagerly. */
  public poll(): void {
    for (const watched of [...this.#watched.values()]) {
      const { registration } = watched;
      if (this.#options.probe(registration.lockFile)) {
        watched.appeared = true;
        continue;
      }
      if (!watched.proven && !watched.appeared) continue;
      const phase: SessionEndPhase = watched.proven ? "live" : "launching";
      this.#options.debug?.(`marker gone agent=${registration.agentId} phase=${phase} lock=${registration.lockFile}`);
      this.#watched.delete(registration.agentId);
      this.#options.onProcessEnded?.({ ...registration, phase });
    }
  }

  public pollSoon(): void {
    const schedule = this.#options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    for (const delay of EXIT_CONFIRMATION_DELAYS_MS) {
      const handle = schedule(() => this.poll(), delay);
      if (typeof handle === "object" && handle !== null && "unref" in handle) {
        (handle as { unref(): void }).unref();
      }
    }
  }
}

export interface SessionEndSettlement {
  settleConversationEnded(agentId: AgentId, reason: SessionEndReason): void;
}

export interface SessionLifecycleServiceOptions {
  readonly fleet: FleetRegistry;
  readonly monitor: SessionProcessMonitor;
  readonly settlement: SessionEndSettlement;
  /** The wrapper's marker path for an agent; launch-time state the hook knows nothing about. */
  readonly lockPathFor: (agentId: AgentId) => string;
  readonly onSessionStarted?: (observation: SessionStartObservation) => void;
  /** Injected timers keep the `/resume` grace window deterministic in tests. */
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly resumeGraceMs?: number;
}

const RESUME_GRACE_MS = 3_000;

export class SessionLifecycleService {
  readonly #pendingResume = new Map<AgentId, { readonly sessionId: SessionId; readonly timer: unknown }>();

  public constructor(private readonly options: SessionLifecycleServiceOptions) {}

  /** SessionStart = proof-of-life: registers the wrapper's marker for polling. */
  public sessionStarted(observation: SessionStartObservation): boolean {
    const pending = this.#pendingResume.get(observation.agentId);
    if (pending !== undefined) {
      this.#cancelPendingResume(observation.agentId);
      if (pending.sessionId !== observation.sessionId) this.#settle(observation.agentId, pending.sessionId, "resume");
    }
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

  public sessionEnded(observation: SessionEndObservation): boolean {
    if (observation.reason === "resume") return this.#scheduleResumeSettlement(observation);
    if (observation.reason !== "clear") {
      if (this.options.monitor.isTracked(observation.agentId)) this.options.monitor.pollSoon();
      return false;
    }
    return this.#settle(observation.agentId, observation.sessionId, "clear");
  }

  /** Drop pending grace timers so deactivation leaves nothing scheduled. */
  public dispose(): void {
    for (const agentId of [...this.#pendingResume.keys()]) this.#cancelPendingResume(agentId);
  }

  #scheduleResumeSettlement(observation: SessionEndObservation): boolean {
    if (!this.#settleable(observation.agentId, observation.sessionId)) return false;
    this.#cancelPendingResume(observation.agentId);
    const schedule = this.options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    let timer: unknown;
    timer = schedule(() => {
      // Only the window still on record may settle: a cancelled or superseded
      // one must stay inert even if its timer somehow fires.
      if (this.#pendingResume.get(observation.agentId)?.timer !== timer) return;
      this.#pendingResume.delete(observation.agentId);
      this.#settle(observation.agentId, observation.sessionId, "resume");
    }, this.options.resumeGraceMs ?? RESUME_GRACE_MS);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
    this.#pendingResume.set(observation.agentId, { sessionId: observation.sessionId, timer });
    return true;
  }

  #cancelPendingResume(agentId: AgentId): void {
    const pending = this.#pendingResume.get(agentId);
    if (pending === undefined) return;
    this.#pendingResume.delete(agentId);
    const clear = this.options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
    clear(pending.timer);
  }

  #settleable(agentId: AgentId, sessionId: SessionId): boolean {
    const session = this.options.fleet.get(agentId);
    if (session === undefined || session.sessionId !== sessionId) return false;
    return session.lifecycle.status !== "completed" && session.lifecycle.status !== "failed";
  }

  #settle(agentId: AgentId, sessionId: SessionId, reason: SessionEndReason): boolean {
    if (!this.#settleable(agentId, sessionId)) return false;
    this.options.monitor.untrack(agentId);
    this.options.settlement.settleConversationEnded(agentId, reason);
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
    super(`Agent session did not start within ${Math.round(timeoutMs / 1000)}s; no SessionStart hook fired. Check the terminal for a CLI error.`);
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
