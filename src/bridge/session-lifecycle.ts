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
 * Marker removal and terminal-close settle identically; `/clear` and an
 * interactive `/resume` switch fire SessionEnd while the process (and marker)
 * stay alive, so they are handled as graceful conversation ends instead.
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

/**
 * `launching` means the wrapper's child exited before any SessionStart hook
 * fired: the Claude CLI died on its way up — a rejected flag, an auth wall, a
 * session id it refuses to resume — and printed its reason into the terminal.
 * `live` is an ordinary session ending. The distinction matters because a
 * failed launch has to be reported, while a session ending is routine.
 */
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

/**
 * Retry ladder for a reported-but-not-yet-visible exit. A SessionEnd hook runs
 * *inside* the dying process, so its marker still exists when the hook lands;
 * these delays cover the gap between the report and the wrapper's cleanup
 * without waiting for the next interval sweep.
 */
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

  /**
   * Watch a launch that has no session yet. Until the marker first appears the
   * agent cannot die — the wrapper is still starting — so a missing marker here
   * means "not yet", not "gone". Once it has appeared, its removal without an
   * intervening SessionStart is a failed launch.
   */
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

  /**
   * Liveness observation for lease stale-recovery. "live" only while the
   * marker file exists; untracked agents (session not started, or settled)
   * report "missing" so a dead terminal cannot be masked by a hook that never
   * fired.
   */
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
      // Never seen, and no hook has proved otherwise: the wrapper is still
      // starting up. Its failure to ever appear is the startup proof's
      // business, not a death to report. A SessionStart hook settles it the
      // other way — the marker precedes the TUI, so it existed.
      if (!watched.proven && !watched.appeared) continue;
      const phase: SessionEndPhase = watched.proven ? "live" : "launching";
      this.#options.debug?.(`marker gone agent=${registration.agentId} phase=${phase} lock=${registration.lockFile}`);
      this.#watched.delete(registration.agentId);
      this.#options.onProcessEnded?.({ ...registration, phase });
    }
  }

  /**
   * Sweep repeatedly over the next few seconds. Used when something reports an
   * exit that the filesystem has not shown yet; each sweep is a stat per tracked
   * agent, and an agent that settles early simply drops out of the map.
   */
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
  /**
   * Settle a conversation that ended while its process and terminal live on:
   * `/clear`, or an interactive `/resume` that switched the TUI to a different
   * conversation. Releases the lease and removes the agent from the fleet; the
   * terminal itself is left to the user, who deliberately kept it.
   */
  settleConversationEnded(agentId: AgentId, reason: SessionEndReason): void;
}

export interface SessionLifecycleServiceOptions {
  readonly fleet: FleetRegistry;
  readonly monitor: SessionProcessMonitor;
  readonly settlement: SessionEndSettlement;
  /** The wrapper's marker path for an agent — launch-time state the hook knows nothing about. */
  readonly lockPathFor: (agentId: AgentId) => string;
  readonly onSessionStarted?: (observation: SessionStartObservation) => void;
  /** Injected timers keep the `/resume` grace window deterministic in tests. */
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly resumeGraceMs?: number;
}

/**
 * Grace window between SessionEnd(`resume`) and the SessionStart that follows
 * it inside the same process. Interactive `/resume` usually switches the TUI to
 * another conversation — aboard's session is over even though the process and
 * marker live on — but the picker may also land back on the session aboard
 * launched, which never ended. Only the following SessionStart's id tells the
 * two apart, so the settlement waits for it. Short, because the agent still
 * holds the write lease until it elapses.
 */
const RESUME_GRACE_MS = 3_000;

export class SessionLifecycleService {
  readonly #pendingResume = new Map<AgentId, { readonly sessionId: SessionId; readonly timer: unknown }>();

  public constructor(private readonly options: SessionLifecycleServiceOptions) {}

  /** SessionStart = proof-of-life: registers the wrapper's marker for polling. */
  public sessionStarted(observation: SessionStartObservation): boolean {
    const pending = this.#pendingResume.get(observation.agentId);
    if (pending !== undefined) {
      this.#cancelPendingResume(observation.agentId);
      // A different id proves the TUI switched conversations, so settle now
      // instead of waiting out the rest of the window. The same id means the
      // picker returned to aboard's own session and nothing ended.
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

  /**
   * SessionEnd is a conversation-level event with a 1.5s hook budget, so this
   * must stay cheap. Only conversation-level reasons settle here: the process
   * demonstrably lives on (it fired the hook inside a kept-alive TUI), so
   * marker polling will never settle these. `clear` settles immediately;
   * `resume` waits for the next SessionStart to say whether the TUI actually
   * moved to another session. Process-exit reasons (`prompt_input_exit`,
   * `logout`, ...) still belong to the marker, which is authoritative — the
   * hook runs inside the process it is announcing the death of — but they are
   * an early warning, so they kick off a short confirmation ladder instead of
   * waiting for the next interval sweep.
   */
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
