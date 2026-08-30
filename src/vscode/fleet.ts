import type { AgentId, AgentSession, ChildAgentNode, IsoTimestamp, TerminalId, WorkerFailureType } from "../domain/contracts.js";
import type { FleetEvent, FleetRegistry } from "../domain/fleet.js";
import type { LeaseAuditEvent, WriteLease } from "../domain/lease.js";
import { describeIssueNumbers, formatIssueNumbers } from "../shared/issues.js";

export type FleetTreeNode =
  | { readonly kind: "new-manager" }
  | { readonly kind: "agent"; readonly session: AgentSession; readonly leaseHolder: boolean }
  | { readonly kind: "child"; readonly child: ChildAgentNode };

export interface FleetTreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly contextValue: "aboard.action.newManager" | "aboard.agent.active" | "aboard.child";
  readonly collapsible: boolean;
  readonly command?:
    | { readonly command: "aboard.newManager"; readonly title: string; readonly arguments: readonly [] }
    | { readonly command: "aboard.focusAgent"; readonly title: string; readonly arguments: readonly [FleetTreeNode] };
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
    private readonly isManagerLive?: () => boolean,
  ) {
    this.#fleetRegistration = fleet.onDidChange(() => host.refresh());
    this.#leaseRegistration = lease.onDidChange(() => host.refresh());
  }

  public roots(): readonly FleetTreeNode[] {
    const agents = this.fleet.list()
      .filter((session) => isLiveSession(session) && this.isTerminalOpen(session.terminal.terminalId))
      .map((session): FleetTreeNode => ({ kind: "agent", session, leaseHolder: this.lease.current()?.agentId === session.identity.agentId }))
      .sort((left, right) => managerRank(left) - managerRank(right));
    return this.isManagerLive === undefined || this.isManagerLive()
      ? agents
      : [{ kind: "new-manager" }, ...agents];
  }

  /** Only running children: a completed sub-agent is history, not fleet. */
  public children(node: FleetTreeNode): readonly FleetTreeNode[] {
    if (node.kind !== "agent") return [];
    return this.fleet.listChildren(node.session.identity.agentId)
      .filter((child) => child.status === "running")
      .map((child) => ({ kind: "child", child }));
  }

  public item(node: FleetTreeNode): FleetTreeItem {
    if (node.kind === "new-manager") {
      return {
        label: "New Manager",
        description: "",
        tooltip: "Start a new Manager",
        icon: "add",
        contextValue: "aboard.action.newManager",
        collapsible: false,
        command: { command: "aboard.newManager" as const, title: "New Manager", arguments: [] as const },
      };
    }
    if (node.kind === "child") {
      return { label: node.child.type, description: node.child.status, tooltip: childTooltip(node.child), icon: "symbol-method", contextValue: "aboard.child", collapsible: false };
    }
    const { session } = node;
    const goal = session.issueNumbers === undefined ? "" : ` ${formatIssueNumbers(session.issueNumbers)}`;
    const reportsOwed = this.fleet.reportsOwedTo(session.identity.agentId).map(agentLabel);
    const markers = [
      session.lifecycle.status,
      node.leaseHolder ? "lease holder" : "",
      reportsOwed.length === 0 ? "" : `waiting on ${reportsOwed.join(", ")}`,
    ].filter(Boolean);
    return {
      label: `${agentLabel(session)}${goal}`,
      description: markers.join(" · "),
      tooltip: agentTooltip(session, node.leaseHolder, reportsOwed),
      icon: agentIcon(session),
      contextValue: "aboard.agent.active",
      collapsible: this.children(node).length > 0,
      command: { command: "aboard.focusAgent" as const, title: "Focus Agent", arguments: [node] as const },
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
  if (session.identity.type === "manager") return "organization";
  return session.attended === true
    ? "comment-discussion"
    : "lock";
}

/** Lifecycle states that describe an agent still doing something. */
export function isLiveSession(session: AgentSession): boolean {
  return ["starting", "running", "awaiting-user"].includes(session.lifecycle.status);
}

function managerRank(node: FleetTreeNode): number { return node.kind === "agent" && node.session.identity.type === "manager" ? 0 : 1; }
function isAgentNode(value: unknown): value is Extract<FleetTreeNode, { kind: "agent" }> { return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "agent"; }
function agentLabel(session: AgentSession): string {
  if (session.identity.type === "manager") return "Manager";
  return `aboard-${session.identity.type}-${session.identity.agentId}`;
}
// Telemetry is deliberately absent from the tree: the counters are not wired to a
// reliable source yet, and a wrong number is worse than no number.
function agentTooltip(session: AgentSession, leaseHolder: boolean, reportsOwed: readonly string[]): string {
  return [
    `Session: ${session.sessionId}`,
    `Status: ${session.lifecycle.status}`,
    leaseHolder ? "Holds the write lease" : "",
    reportsOwed.length === 0 ? "" : `Waiting on: ${reportsOwed.join(", ")}`,
  ].filter(Boolean).join("\n");
}
function childTooltip(child: ChildAgentNode): string { return [`Type: ${child.type}`, `Status: ${child.status}`].join("\n"); }

export interface FleetNotificationHost { information(message: string): void; warning(message: string): void; error(message: string): void; }
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
  // The Manager is the user's own console: its ending is something they did, not
  // a background result worth a toast.
  if (session?.identity.type === "manager") return;
  if (session?.lifecycle.status === "completed") host.information(`${session.identity.type} completed${session.issueNumbers === undefined ? "" : ` ${describeIssueNumbers(session.issueNumbers)}`}.`);
  else if (session?.lifecycle.status === "failed") host.error(`${session.identity.type} failed: ${failureLabel(session.lifecycle.failure.type)}.`);
}
function failureLabel(type: WorkerFailureType): string { return type.replaceAll("-", " "); }

export interface FleetStatusSnapshot { readonly text: string; readonly tooltip: string; readonly liveAgentCount: number; }
export function renderFleetStatus(port: number, fleet: FleetRegistry, lease: WriteLease, isTerminalOpen: (terminalId: TerminalId) => boolean = () => true): FleetStatusSnapshot {
  const live = fleet.list().filter((entry) => ["starting", "running", "awaiting-user"].includes(entry.lifecycle.status) && isTerminalOpen(entry.terminal.terminalId));
  const holder = lease.current()?.agentId;
  return { text: `$(organization) ${live.length} · :${port}${holder === undefined ? "" : ` · $(lock) ${holder}`}`, tooltip: `aboard bridge: 127.0.0.1:${port}\nLive agents: ${live.length}\nWrite lease: ${holder ?? "free"}`, liveAgentCount: live.length };
}

export function saveLeaseWarning(lease: WriteLease): string | undefined {
  const holder = lease.current();
  return holder === undefined ? undefined : `You saved a file while ${holder.agentId} holds the aboard write lease. Your edit was saved, but concurrent changes may conflict.`;
}
