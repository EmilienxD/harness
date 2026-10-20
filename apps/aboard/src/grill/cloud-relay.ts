import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, parse, relative, sep } from "node:path";
import type { FleetRegistry } from "../domain/fleet.js";
import type { AgentPlatformId, SessionId } from "../domain/contracts.js";
import type { PromptSubmissions } from "../platform/prompt-submissions.js";
import { validateResumeMessage, type TerminalController } from "../platform/terminals.js";

type Presence = { readonly provider: AgentPlatformId; readonly session_id: string };
type Delivery = { readonly delivery_id: string; readonly provider: AgentPlatformId; readonly session_id: string; readonly prompt: string };
type Acknowledgement = { readonly delivery_id: string; readonly status: "submitted-to-terminal" | "failed"; readonly failure_message?: string };
type Workspace = { readonly name: string; readonly path: string };

export interface GrillCloudRelayOptions {
  readonly fleet: FleetRegistry;
  readonly terminals: TerminalController;
  readonly prompts: Pick<PromptSubmissions, "expect">;
  readonly workspaceRoot: string;
  readonly origin: string;
  readonly code: string;
  readonly log: (message: string) => void;
  readonly home?: string;
  readonly activeIntervalMs?: number;
  readonly idleIntervalMs?: number;
  /** Must stay inside the board's 30-second delivery expiry, including claim latency. */
  readonly confirmationTimeoutMs?: number;
}

/**
 * Mirror the publishing hook's `project_identity`: a home-relative display path
 * so the board can name the project without learning the user's home directory.
 */
export function workspaceIdentity(workspaceRoot: string, home: string = homedir()): Workspace {
  const within = relative(home, workspaceRoot);
  const escapes = within === "" ? false : within.split(sep).includes("..") || parse(within).root !== "";
  return {
    name: basename(workspaceRoot) || parse(workspaceRoot).root,
    path: escapes ? workspaceRoot : within === "" ? "~" : `~${sep}${within}`,
  };
}

export class GrillCloudRelay {
  // Workspace-derived so one presence row names its project, and per-activation
  // so two windows on the same folder never overwrite each other's heartbeats.
  readonly #instanceId: string;
  readonly #workspace: Workspace;
  readonly #activeIntervalMs: number;
  readonly #idleIntervalMs: number;
  readonly #confirmationTimeoutMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #running = false;
  #wakeRequested = false;
  #acknowledgements: Acknowledgement[] = [];

  public constructor(private readonly options: GrillCloudRelayOptions) {
    this.#workspace = workspaceIdentity(options.workspaceRoot, options.home);
    const scope = createHash("sha256").update(options.workspaceRoot).digest("hex").slice(0, 16);
    this.#instanceId = `${scope}:${randomUUID()}`;
    this.#activeIntervalMs = options.activeIntervalMs ?? 5_000;
    this.#idleIntervalMs = options.idleIntervalMs ?? 30_000;
    this.#confirmationTimeoutMs = options.confirmationTimeoutMs ?? 15_000;
  }

  public get instanceId(): string {
    return this.#instanceId;
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
        body: JSON.stringify({ instance_id: this.#instanceId, workspace: this.#workspace, sessions, acknowledgements: sent }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { deliveries?: Delivery[] };
      this.#acknowledgements.splice(0, sent.length);
      // Confirmation can take seconds; awaiting it here would stall the heartbeat
      // and let this project's presence expire mid-delivery.
      for (const delivery of body.deliveries ?? []) void this.#deliver(delivery);
    } catch (error) {
      this.options.log(`Grill relay sync failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.#running = false;
      const delay = this.#wakeRequested ? 0 : sessions.length ? this.#activeIntervalMs : this.#idleIntervalMs;
      this.#wakeRequested = false;
      if (!this.#stopped) this.#timer = setTimeout(() => { this.#timer = undefined; void this.#tick(); }, delay);
    }
  }

  /** Report an outcome now instead of on the next heartbeat, so the board stops waiting sooner. */
  #wake(): void {
    if (this.#stopped) return;
    if (this.#running) { this.#wakeRequested = true; return; }
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    void this.#tick();
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
      presence.push({ provider: session.platform, session_id: session.sessionId });
    }
    return presence;
  }

  async #deliver(delivery: Delivery): Promise<void> {
    this.#acknowledgements.push(await this.#submit(delivery));
    this.#wake();
  }

  async #submit(delivery: Delivery): Promise<Acknowledgement> {
    try {
      const session = this.options.fleet.getBySession(delivery.session_id as SessionId);
      if (session === undefined || session.platform !== delivery.provider || session.sessionBinding !== "bound") throw new Error("Exact provider session is not registered");
      const terminalId = this.options.terminals.liveTerminalForAgent(session.identity.agentId);
      if (terminalId === undefined) throw new Error("Provider terminal is no longer open");
      const terminal = this.options.terminals.get(terminalId);
      if (terminal.backend !== "terminal" || terminal.sessionId !== delivery.session_id) throw new Error("Terminal binding changed before submission");
      validateResumeMessage(delivery.prompt);
      if (this.#stopped) throw new Error("Grill relay stopped before submission");
      const expectation = this.options.prompts.expect(session.sessionId, this.#confirmationTimeoutMs);
      try {
        await this.options.terminals.sendResumeMessage(terminalId, delivery.prompt, { normalizeFileReferences: false });
      } catch (error) {
        expectation.cancel();
        throw error;
      }
      if (!await expectation.confirmed) {
        throw new Error(`The provider did not confirm the prompt within ${Math.round(this.#confirmationTimeoutMs / 1000)} seconds`);
      }
      this.options.log(`Grill delivery ${delivery.delivery_id} confirmed by ${delivery.provider} session ${delivery.session_id}.`);
      return { delivery_id: delivery.delivery_id, status: "submitted-to-terminal" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Terminal submission failed";
      this.options.log(`Grill delivery ${delivery.delivery_id} failed: ${message}`);
      return { delivery_id: delivery.delivery_id, status: "failed", failure_message: message.slice(0, 500) };
    }
  }
}

const DEFAULT_GRILL_URL = "https://grill-me-in-cloud.vercel.app";

type GrillSection = { readonly url?: unknown; readonly code?: unknown };

function grillSection(path: string): GrillSection {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Harness config at ${path} could not be read`);
  }
  let config: unknown;
  try { config = JSON.parse(text) as unknown; }
  catch { throw new Error(`Harness config at ${path} contains invalid JSON`); }
  if (typeof config !== "object" || config === null || Array.isArray(config) || (config as { version?: unknown }).version !== 1) {
    throw new Error(`Harness config at ${path} must be a version-1 JSON object`);
  }
  const section = (config as { grill?: unknown }).grill ?? {};
  if (typeof section !== "object" || section === null || Array.isArray(section)) throw new Error(`Harness config at ${path}: grill must be an object`);
  return section;
}

/**
 * Mirror the publishing hook's `HostedClient.from_environment`, so the relay
 * heartbeats to the same board that received the project's rounds.
 */
export function grillTarget(workspaceRoot: string, environment: NodeJS.ProcessEnv, home: string = homedir()): { readonly origin: unknown; readonly code: unknown } {
  const local = grillSection(join(workspaceRoot, ".harness", "config.local.json"));
  const shared = grillSection(join(workspaceRoot, ".harness", "config.json"));
  const user = grillSection(join(environment.HARNESS_STATE_DIR || join(home, ".harness"), "config.json"));
  return {
    origin: local.url || shared.url || user.url || environment.HARNESS_GRILL_URL || DEFAULT_GRILL_URL,
    // The committed project config never supplies the code.
    code: local.code || user.code || environment.HARNESS_GRILL_CODE,
  };
}

/**
 * Callers create one relay per initialized lifetime of the workspace, so a
 * project that is not initialized never reports presence or polls the board.
 */
export function createGrillCloudRelay(options: Omit<GrillCloudRelayOptions, "origin" | "code"> & { readonly environment?: NodeJS.ProcessEnv }): GrillCloudRelay | undefined {
  let target: ReturnType<typeof grillTarget>;
  try { target = grillTarget(options.workspaceRoot, options.environment ?? process.env, options.home); }
  catch (error) {
    options.log(`Grill relay disabled: ${error instanceof Error ? error.message : "Harness config is invalid"}.`);
    return undefined;
  }
  const { origin, code } = target;
  if (!code) return undefined;
  if (typeof origin !== "string" || !origin || typeof code !== "string" || !/^\d{4}$/u.test(code)) {
    options.log("Grill relay disabled: set a four-digit grill.code in .harness/config.local.json or ~/.harness/config.json, or through HARNESS_GRILL_CODE. grill.url or HARNESS_GRILL_URL optionally overrides https://grill-me-in-cloud.vercel.app.");
    return undefined;
  }
  try {
    const url = new URL(origin);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.origin !== origin) throw new Error();
  } catch {
    options.log("Grill relay disabled: the grill URL must be an HTTP(S) origin without a trailing slash.");
    return undefined;
  }
  return new GrillCloudRelay({ ...options, origin, code });
}
