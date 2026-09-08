import type { AgentId, IsoTimestamp, SessionId, WorkerFailure } from "./contracts.js";
import type { WriteCapability } from "./capability.js";

export interface WriteLeaseHolder {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly acquiredAt: IsoTimestamp;
}

export type LeaseAuditEvent =
  | { readonly type: "acquired"; readonly occurredAt: IsoTimestamp; readonly holder: WriteLeaseHolder; readonly reason: string }
  | { readonly type: "released" | "force-released" | "stale-released"; readonly occurredAt: IsoTimestamp; readonly holder: WriteLeaseHolder; readonly reason: string };

export type LeaseAcquisition =
  | { readonly acquired: true; readonly required: boolean; readonly holder?: WriteLeaseHolder }
  | { readonly acquired: false; readonly required: true; readonly holder: WriteLeaseHolder; readonly ageMs: number };

/** Who started an agent, which is what decides whether the launch is leased. */
export type LaunchOrigin = "auto-run" | "user";

export function leaseRequired(origin: LaunchOrigin, _interactive: boolean): boolean {
  return origin === "auto-run";
}

export type TerminalObservation = "open" | "closed" | "missing";
export type SessionObservation = "live" | "ended" | "missing";

export interface LeaseHolderObservation {
  readonly terminal: TerminalObservation;
  readonly session: SessionObservation;
}

/** A lease is stale only when neither observable source says its holder is live. */
export function isStaleLease(observation: LeaseHolderObservation): boolean {
  return observation.terminal !== "open" && observation.session !== "live";
}

export class WriteLease {
  #holder: WriteLeaseHolder | undefined;
  readonly #audit: LeaseAuditEvent[] = [];
  readonly #listeners = new Set<(event: LeaseAuditEvent) => void>();

  public onDidChange(listener: (event: LeaseAuditEvent) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  public current(): WriteLeaseHolder | undefined {
    return this.#holder;
  }

  public events(): readonly LeaseAuditEvent[] {
    return [...this.#audit];
  }

  public acquire(
    capability: WriteCapability,
    identity: { readonly agentId: AgentId; readonly sessionId: SessionId },
    occurredAt: IsoTimestamp,
    reason: string,
  ): LeaseAcquisition {
    if (capability === "read-only") return { acquired: true, required: false };
    if (this.#holder !== undefined) {
      return {
        acquired: false,
        required: true,
        holder: this.#holder,
        ageMs: Math.max(0, Date.parse(occurredAt) - Date.parse(this.#holder.acquiredAt)),
      };
    }
    const auditReason = requireReason(reason);
    const holder = { ...identity, acquiredAt: occurredAt };
    this.#holder = holder;
    this.#record({ type: "acquired", occurredAt, holder, reason: auditReason });
    return { acquired: true, required: true, holder };
  }

  public release(agentId: AgentId, occurredAt: IsoTimestamp, reason: string): boolean {
    if (this.#holder?.agentId !== agentId) return false;
    this.recordRelease("released", occurredAt, reason);
    return true;
  }

  public forceRelease(occurredAt: IsoTimestamp, reason: string): boolean {
    if (this.#holder === undefined) return false;
    this.recordRelease("force-released", occurredAt, reason);
    return true;
  }

  public recoverStale(
    observation: LeaseHolderObservation,
    occurredAt: IsoTimestamp,
    reason: string,
  ): boolean {
    if (this.#holder === undefined || !isStaleLease(observation)) return false;
    this.recordRelease("stale-released", occurredAt, reason);
    return true;
  }

  /** Terminal completion releases the lease on success and every failure path. */
  public releaseForTerminalOutcome(agentId: AgentId, occurredAt: IsoTimestamp, reason: string): boolean {
    return this.release(agentId, occurredAt, reason);
  }

  private recordRelease(type: "released" | "force-released" | "stale-released", occurredAt: IsoTimestamp, reason: string): void {
    const auditReason = requireReason(reason);
    const holder = this.#holder!;
    this.#holder = undefined;
    this.#record({ type, occurredAt, holder, reason: auditReason });
  }

  #record(event: LeaseAuditEvent): void {
    this.#audit.push(event);
    for (const listener of this.#listeners) listener(event);
  }
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new Error("Lease audit reason must not be empty");
  return trimmed;
}

export function dirtyTreeFailure(
  exitCode: number | null,
  lastAssistantMessage: string | null,
): WorkerFailure {
  return { type: "no-commit", exitCode, lastAssistantMessage };
}
