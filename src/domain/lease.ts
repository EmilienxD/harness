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
export type LaunchOrigin = "manager" | "auto-run" | "user";

/**
 * Which launches take the write lease.
 *
 * The lease serializes work *aboard* drives, not the user's own hands, so it
 * follows who the agent answers to. An automated Manager launch reports its
 * result back to aboard and is leased. An interactive launch is a conversation
 * handed to the user — `--prompt` there only names the topic it opens on, and
 * the user drives every turn after it — so it is **not** leased, whether or not
 * a first message was supplied. Parallel work in a terminal the user is driving
 * is theirs to allow.
 *
 * Auto-run is the one exception: every launch of a run is leased, the
 * interactive `pr-doctor-hitl` included, because the extension keeps
 * committing, pushing, and merging behind that terminal while the run is in
 * flight — which is exactly the collision the lease exists to prevent.
 *
 * Restores, resumes, and anything the user starts or types by hand take no
 * lease. The status bar, the fleet row, and `aboard release-lease` remain the
 * controls there.
 *
 * Capability is still derived, never declared: this decides only *whether* a
 * launch competes for the lease, and a read-only agent takes none either way.
 */
export function leaseRequired(origin: LaunchOrigin, interactive: boolean): boolean {
  return origin === "auto-run" || (origin === "manager" && !interactive);
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
