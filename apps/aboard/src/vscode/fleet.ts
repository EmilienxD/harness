import { agentLabel, isHeadlessExecution, type AgentId, type AgentSession, type IsoTimestamp, type TerminalId, type WorkerFailureType } from "../domain/contracts.js";
import type { FleetEvent, FleetRegistry } from "../domain/fleet.js";
import type { LeaseAuditEvent, WriteLease } from "../domain/lease.js";
import type { AutoRunState } from "../auto/engine.js";
import { formatIssueNumbers } from "../shared/issues.js";

export type FleetTreeNode =
  { readonly kind: "agent"; readonly session: AgentSession; readonly leaseHolder: boolean }; 

export interface FleetTreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly contextValue: "aboard.agent.interactive" | "aboard.agent.background";
  readonly collapsible: boolean;
  readonly command?:
    | { readonly command: "aboard.focusAgent" | "aboard.watchAgent"; readonly title: string; readonly arguments: readonly [FleetTreeNode] };
}

export interface FleetTreeHost {
  refresh(): void;
}

export class FleetTreeModel {
  readonly #fleetRegistration: { dispose(): void };
  readonly #leaseRegistration: { dispose(): void };

  public constructor(
    private readonly fleet: FleetRegistry,
    private readonly lease: WriteLease,
    host: FleetTreeHost,
    private readonly isTerminalOpen: (terminalId: TerminalId) => boolean = () => true,
  ) {
    this.#fleetRegistration = fleet.onDidChange(() => host.refresh());
    this.#leaseRegistration = lease.onDidChange(() => host.refresh());
  }

  public roots(): readonly FleetTreeNode[] {
    const agents = this.fleet.list()
      .filter((session) => isLiveSession(session) && this.isTerminalOpen(session.terminal.terminalId))
      .map((session): FleetTreeNode => ({ kind: "agent", session, leaseHolder: this.lease.current()?.agentId === session.identity.agentId }));
    return agents;
  }


  public item(node: FleetTreeNode): FleetTreeItem {

    const { session } = node;
    const background = isBackground(session);
    const goal = session.issueNumbers === undefined ? "" : ` ${formatIssueNumbers(session.issueNumbers)}`;
    const markers = [
      providerLabel(session.platform),
      session.lifecycle.status,
      node.leaseHolder ? "lease holder" : "",
    ].filter(Boolean);
    return {
      label: `${agentLabel(session.identity)}${goal}`,
      description: markers.join(" · "),
      tooltip: agentTooltip(session, node.leaseHolder),
      icon: agentIcon(session),
      contextValue: background ? "aboard.agent.background" : "aboard.agent.interactive",
      collapsible: false,
      command: background
        ? { command: "aboard.watchAgent", title: "Watch Agent", arguments: [node] }
        : { command: "aboard.focusAgent", title: "Focus Agent", arguments: [node] },
    };
  }

  public dispose(): void { this.#fleetRegistration.dispose(); this.#leaseRegistration.dispose(); }
}

export interface AgentCommandHost {
  register(command: string, callback: (...args: readonly unknown[]) => unknown): { dispose(): void };
  confirm(message: string, action: string): Promise<boolean>;
  info(message: string): void;
  error(message: string): void;
}

export interface AgentTerminalActions {
  show(terminalId: TerminalId): void;
  kill(terminalId: TerminalId): void;
  isOpen?(terminalId: TerminalId): boolean;
}

export function registerFleetCommands(host: AgentCommandHost, terminals: AgentTerminalActions, fleet: FleetRegistry, lease: WriteLease, now: () => Date = () => new Date()): { dispose(): void } {
  const sessionOf = (value: unknown): AgentSession | undefined => isAgentNode(value) ? value.session : undefined;
  const registrations = [
    host.register("aboard.focusAgent", (value) => {
      const session = sessionOf(value);
      if (session === undefined) return;
      // A row only reaches this view while its terminal is open, so a closed one
      // means the tree is a frame behind rather than that the user chose wrong.
      if (terminals.isOpen?.(session.terminal.terminalId) === false) {
        return host.info("That session's terminal has closed. Recent Activity has what became of it.");
      }
      terminals.show(session.terminal.terminalId);
    }),
    host.register("aboard.killAgent", async (value) => {
      const session = sessionOf(value);
      if (session === undefined) return;
      if (terminals.isOpen?.(session.terminal.terminalId) === false) return host.info("That session's terminal has already closed.");
      if (await host.confirm(`Kill ${session.identity.type}?`, "Kill")) terminals.kill(session.terminal.terminalId);
    }),
    host.register("aboard.forceReleaseLease", async () => { const holder = lease.current(); if (holder === undefined) return host.info("No write lease is held."); if (await host.confirm(`Force release the write lease held by ${holder.agentId}?`, "Release")) lease.forceRelease(now().toISOString() as IsoTimestamp, "user force release from VS Code"); }),
  ];
  return { dispose: () => registrations.forEach((entry) => entry.dispose()) };
}

function agentIcon(session: AgentSession): string {
  return isBackground(session) ? "eye-closed" : "eye";
}

function isBackground(session: AgentSession): boolean {
  return isHeadlessExecution(session.identity.type, session.executionMode);
}

function providerLabel(platform: AgentSession["platform"]): "Claude" | "Codex" {
  return platform === "claude" ? "Claude" : "Codex";
}

/** Lifecycle states that describe an agent still doing something. */
export function isLiveSession(session: AgentSession): boolean {
  return ["starting", "running", "awaiting-user"].includes(session.lifecycle.status);
}


function isAgentNode(value: unknown): value is Extract<FleetTreeNode, { kind: "agent" }> { return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "agent"; }
// Telemetry is deliberately absent from the tree: the counters are not wired to a
// reliable source yet, and a wrong number is worse than no number.
function agentTooltip(session: AgentSession, leaseHolder: boolean): string {
  return [
    `Provider: ${providerLabel(session.platform)}`,
    `Mode: ${isBackground(session) ? "Background" : "Interactive"}`,
    `Session: ${session.sessionId}`,
    `Status: ${session.lifecycle.status}`,
    leaseHolder ? "Holds the write lease" : "",
  ].filter(Boolean).join("\n");
}

export interface FleetNotificationHost { warning(message: string): void; error(message: string): void; }
export class FleetNotifications {
  readonly #fleetRegistration: { dispose(): void };
  public constructor(fleet: FleetRegistry, private readonly host: FleetNotificationHost) {
    this.#fleetRegistration = fleet.onDidChange((event) => notify(event, fleet, host));
  }
  public leaseConflict(holder: AgentId, acquiredAt: IsoTimestamp): void { this.host.warning(`Write lease conflict: ${holder} has held the lease since ${acquiredAt}.`); }
  public scaffoldConflict(message: string): void { this.host.warning(message); }
  public dispose(): void { this.#fleetRegistration.dispose(); }
}

function notify(event: FleetEvent, fleet: FleetRegistry, host: FleetNotificationHost): void {
  if (event.type !== "lifecycle-transitioned" || (event.to !== "completed" && event.to !== "failed")) return;
  const session = fleet.get(event.agentId);

  if (session?.lifecycle.status === "failed") host.error(`${session.identity.type} failed: ${failureLabel(session.lifecycle.failure.type)}.`);
}
function failureLabel(type: WorkerFailureType): string { return type.replaceAll("-", " "); }

export interface FleetStatusSnapshot { readonly text: string; readonly tooltip: string; readonly liveAgentCount: number; }
export function renderFleetStatus(
  port: number,
  fleet: FleetRegistry,
  lease: WriteLease,
  isTerminalOpen: (terminalId: TerminalId) => boolean = () => true,
  autoRun?: AutoRunState,
): FleetStatusSnapshot {
  const live = fleet.list().filter((entry) => ["starting", "running", "awaiting-user"].includes(entry.lifecycle.status) && isTerminalOpen(entry.terminal.terminalId));
  const holder = lease.current()?.agentId;
  const autoRunLines = autoRun === undefined
    ? ["Auto Run: inactive"]
    : [
        `Auto Run: ${autoRun.waiting ? "waiting for commit" : "running"}`,
        `Run: ${autoRun.runId}`,
        `Phase: ${autoRun.phase}`,
        `Current issue: ${autoRun.currentIssue === undefined ? "none" : `#${autoRun.currentIssue}`}`,
        `Progress: ${autoRun.completedCount}/${autoRun.totalCount}`,
        `Pull request: ${autoRun.currentPullRequest === undefined ? "none" : `#${autoRun.currentPullRequest}`}`,
      ];
  return {
    text: "$(organization)",
    tooltip: [
      "aboard",
      `Bridge: 127.0.0.1:${port}`,
      `Live agents: ${live.length}`,
      `Write lease: ${holder ?? "free"}`,
      "",
      ...autoRunLines,
    ].join("\n"),
    liveAgentCount: live.length,
  };
}

export function saveLeaseWarning(lease: WriteLease): string | undefined {
  const holder = lease.current();
  return holder === undefined ? undefined : `You saved a file while ${holder.agentId} holds the aboard write lease. Your edit was saved, but concurrent changes may conflict.`;
}

/** Emits at most once for each acquisition; a later holder gets its own warning. */
export class LeaseSaveWarnings {
  #warned: { readonly agentId: AgentId; readonly acquiredAt: IsoTimestamp } | undefined;

  public next(lease: WriteLease): string | undefined {
    const holder = lease.current();
    if (holder === undefined) { this.#warned = undefined; return undefined; }
    if (this.#warned?.agentId === holder.agentId && this.#warned.acquiredAt === holder.acquiredAt) return undefined;
    this.#warned = holder;
    return saveLeaseWarning(lease);
  }
}
