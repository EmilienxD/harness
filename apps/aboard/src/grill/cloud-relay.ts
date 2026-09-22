import { randomUUID } from "node:crypto";
import type { FleetRegistry } from "../domain/fleet.js";
import type { AgentPlatformId, SessionId } from "../domain/contracts.js";
import type { TerminalController } from "../platform/terminals.js";

type Presence = { readonly provider: AgentPlatformId; readonly session_id: string; readonly state: "running" | "awaiting-user" };
type Delivery = { readonly delivery_id: string; readonly provider: AgentPlatformId; readonly session_id: string; readonly prompt: string };
type Acknowledgement = { readonly delivery_id: string; readonly status: "submitted-to-terminal" | "failed"; readonly failure_message?: string };

export interface GrillCloudRelayOptions {
  readonly fleet: FleetRegistry;
  readonly terminals: TerminalController;
  readonly origin: string;
  readonly code: string;
  readonly log: (message: string) => void;
  readonly activeIntervalMs?: number;
  readonly idleIntervalMs?: number;
}

export class GrillCloudRelay {
  readonly #instanceId = randomUUID();
  readonly #activeIntervalMs: number;
  readonly #idleIntervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #running = false;
  #acknowledgements: Acknowledgement[] = [];

  public constructor(private readonly options: GrillCloudRelayOptions) {
    this.#activeIntervalMs = options.activeIntervalMs ?? 5_000;
    this.#idleIntervalMs = options.idleIntervalMs ?? 30_000;
  }

  public start(): void {
    if (this.#timer !== undefined || this.#running || this.#stopped) return;
    void this.#tick();
  }

  public dispose(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #tick(): Promise<void> {
    if (this.#stopped || this.#running) return;
    this.#running = true;
    const sessions = this.#presence();
    try {
      const sent = [...this.#acknowledgements];
      const response = await fetch(`${this.options.origin}/api/v1/aboard/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.code}`, "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: this.#instanceId, sessions, acknowledgements: sent }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { deliveries?: Delivery[] };
      this.#acknowledgements.splice(0, sent.length);
      for (const delivery of body.deliveries ?? []) this.#acknowledgements.push(await this.#submit(delivery));
    } catch (error) {
      this.options.log(`Grill relay sync failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.#running = false;
      if (!this.#stopped) this.#timer = setTimeout(() => { this.#timer = undefined; void this.#tick(); }, sessions.length ? this.#activeIntervalMs : this.#idleIntervalMs);
    }
  }

  #presence(): Presence[] {
    const presence: Presence[] = [];
    for (const session of this.options.fleet.list()) {
      if (session.sessionBinding !== "bound") continue;
      if (session.lifecycle.status !== "running" && session.lifecycle.status !== "awaiting-user") continue;
      const terminalId = this.options.terminals.liveTerminalForAgent(session.identity.agentId);
      if (terminalId === undefined) continue;
      const terminal = this.options.terminals.get(terminalId);
      if (terminal.sessionId !== session.sessionId || terminal.backend !== "terminal") continue;
      presence.push({ provider: session.platform, session_id: session.sessionId, state: session.lifecycle.status });
    }
    return presence;
  }

  async #submit(delivery: Delivery): Promise<Acknowledgement> {
    try {
      const session = this.options.fleet.getBySession(delivery.session_id as SessionId);
      if (session === undefined || session.platform !== delivery.provider || session.sessionBinding !== "bound") throw new Error("Exact provider session is not registered");
      if (session.lifecycle.status !== "awaiting-user") throw new Error("Provider session is no longer awaiting user input");
      const terminalId = this.options.terminals.liveTerminalForAgent(session.identity.agentId);
      if (terminalId === undefined) throw new Error("Provider terminal is no longer open");
      const terminal = this.options.terminals.get(terminalId);
      if (terminal.backend !== "terminal" || terminal.sessionId !== delivery.session_id) throw new Error("Terminal binding changed before submission");
      await this.options.terminals.sendResumeMessage(terminalId, delivery.prompt);
      this.options.log(`Grill delivery ${delivery.delivery_id} submitted to ${delivery.provider} session ${delivery.session_id}.`);
      return { delivery_id: delivery.delivery_id, status: "submitted-to-terminal" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Terminal submission failed";
      this.options.log(`Grill delivery ${delivery.delivery_id} failed: ${message}`);
      return { delivery_id: delivery.delivery_id, status: "failed", failure_message: message.slice(0, 500) };
    }
  }
}

export function createGrillCloudRelay(options: Omit<GrillCloudRelayOptions, "origin" | "code"> & { readonly environment?: NodeJS.ProcessEnv }): GrillCloudRelay | undefined {
  const environment = options.environment ?? process.env;
  const origin = environment.HARNESS_GRILL_URL;
  const code = environment.HARNESS_GRILL_CODE;
  if (!origin && !code) return undefined;
  if (!origin || !code || !/^\d{4}$/u.test(code)) {
    options.log("Grill relay disabled: HARNESS_GRILL_URL and a four-digit HARNESS_GRILL_CODE must both be set.");
    return undefined;
  }
  try {
    const url = new URL(origin);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.origin !== origin) throw new Error();
  } catch {
    options.log("Grill relay disabled: HARNESS_GRILL_URL must be an HTTP(S) origin without a trailing slash.");
    return undefined;
  }
  return new GrillCloudRelay({ ...options, origin, code });
}
