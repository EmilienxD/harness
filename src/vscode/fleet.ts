import { isInteractiveAgentType, isNonRestorablePersistedAgentType, type AgentId, type AgentSession, type ChildAgentNode, type IsoTimestamp, type TerminalId, type WorkerFailureType } from "../domain/contracts.js";
import type { FleetEvent, FleetRegistry } from "../domain/fleet.js";
import type { LeaseAuditEvent, WriteLease } from "../domain/lease.js";
import { describeIssueNumbers, formatIssueNumbers } from "../shared/issues.js";

export type FleetTreeNode =
  | { readonly kind: "agent"; readonly session: AgentSession; readonly leaseHolder: boolean }
  | { readonly kind: "child"; readonly child: ChildAgentNode };

export interface FleetTreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly contextValue: "aboard.agent.active" | "aboard.agent.paused" | "aboard.agent.orphaned" | "aboard.agent.finished" | "aboard.child";
  readonly collapsible: boolean;
  readonly command?: { readonly command: "aboard.focusAgent"; readonly title: string; readonly arguments: readonly [FleetTreeNode] };
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

  /**
   * A single section holds the Manager and its fleet. The Manager is pinned to
   * the top so the row the user talks to never drifts down the worker list.
   */
  public roots(): readonly FleetTreeNode[] {
    return this.fleet.list()
      .map((session): FleetTreeNode => ({ kind: "agent", session, leaseHolder: this.lease.current()?.agentId === session.identity.agentId }))
      .sort((left, right) => managerRank(left) - managerRank(right));
  }

  public children(node: FleetTreeNode): readonly FleetTreeNode[] {
    if (node.kind === "child") return [];
    return this.fleet.listChildren(node.session.identity.agentId).map((child) => ({ kind: "child", child }));
  }

  public item(node: FleetTreeNode): FleetTreeItem {
    if (node.kind === "child") {
      return { label: node.child.type, description: node.child.status, tooltip: childTooltip(node.child), icon: "symbol-method", contextValue: "aboard.child", collapsible: false };
    }
    const { session } = node;
    const goal = session.issueNumbers === undefined ? "" : ` ${formatIssueNumbers(session.issueNumbers)}`;
    const terminalOpen = this.isTerminalOpen(session.terminal.terminalId);
    const active = ["starting", "running", "awaiting-user"].includes(session.lifecycle.status);
    const orphaned = active && !terminalOpen && isNonRestorablePersistedAgentType(session.identity.type);
    const markers = [terminalOpen ? session.lifecycle.status : orphaned ? "interrupted · result caller gone" : "paused", node.leaseHolder ? "lease holder" : ""].filter(Boolean);
    return {
      // The label matches the per-launch Claude session name — aboard-<type>-<id>,
      // the `@<name>` banner in the terminal head — so a row in the tree is
      // greppable straight back to the running session and its definition file.
      label: `${agentLabel(session)}${goal}`,
      description: markers.join(" · "),
      tooltip: agentTooltip(session, node.leaseHolder, terminalOpen, orphaned),
      icon: agentIcon(session),
      contextValue: active ? terminalOpen ? "aboard.agent.active" : orphaned ? "aboard.agent.orphaned" : "aboard.agent.paused" : "aboard.agent.finished",
      collapsible: this.fleet.listChildren(session.identity.agentId).length > 0,
      ...(terminalOpen ? { command: { command: "aboard.focusAgent" as const, title: "Focus Agent", arguments: [node] as const } } : {}),
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
      if (terminals.isOpen?.(session.terminal.terminalId) === false) {
        return host.info(isNonRestorablePersistedAgentType(session.identity.type)
          ? "This automated session was interrupted after its result caller ended and cannot be restored. Remove it from the fleet."
          : "This session is paused. Use Restore Fleet to reopen its terminal.");
      }
      terminals.show(session.terminal.terminalId);
    }),
    host.register("aboard.killAgent", async (value) => {
      const session = sessionOf(value);
      if (session === undefined) return;
      if (terminals.isOpen?.(session.terminal.terminalId) === false) return host.info("This session has no live terminal. Remove it from the fleet instead.");
      if (await host.confirm(`Kill ${session.identity.type}?`, "Kill")) terminals.kill(session.terminal.terminalId);
    }),
    host.register("aboard.removePausedSession", async (value) => {
      const session = sessionOf(value);
      if (session === undefined || terminals.isOpen?.(session.terminal.terminalId) !== false) return;
      if (!await host.confirm(`Remove the interrupted ${session.identity.type} session from the fleet? Its Claude transcript will stay on disk.`, "Remove")) return;
      const occurredAt = now().toISOString() as IsoTimestamp;
      lease.release(session.identity.agentId, occurredAt, "paused session removed by user");
      fleet.remove(session.identity.agentId, occurredAt);
      host.info("Interrupted session removed from the fleet. Its Claude transcript remains on disk.");
    }),
    // Recovery hatch only, reachable from the Command Palette: a worker that dies
    // without releasing the write lease would otherwise block every later
    // write-capable launch.
    host.register("aboard.forceReleaseLease", async () => { const holder = lease.current(); if (holder === undefined) return host.info("No write lease is held."); if (await host.confirm(`Force release the write lease held by ${holder.agentId}?`, "Release")) lease.forceRelease(now().toISOString() as IsoTimestamp, "user force release from VS Code"); }),
  ];
  return { dispose: () => registrations.forEach((entry) => entry.dispose()) };
}

/**
 * The icon separates agents you may talk to from agents that run to completion
 * on their own: the Manager coordinates, interactive agents are handed to the
 * user, and automated workers are closed to input. Handed-to-the-user is per
 * launch (`resultDelivery.mode === "none"`), not only per type, since the
 * builtin types run either way. It deliberately does not encode the write
 * lease — that is orthogonal and already shown in the row description.
 */
function agentIcon(session: AgentSession): string {
  if (session.identity.type === "manager") return "organization";
  return isInteractiveAgentType(session.identity.type) || session.resultDelivery.mode === "none"
    ? "comment-discussion"
    : "lock";
}

function managerRank(node: FleetTreeNode): number { return node.kind === "agent" && node.session.identity.type === "manager" ? 0 : 1; }
function isAgentNode(value: unknown): value is Extract<FleetTreeNode, { kind: "agent" }> { return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "agent"; }
/**
 * The fleet row names a session the way the running terminal names it: the
 * rewritten definition aboard launches under — `aboard-<type>-<id>` — is the
 * `@<name>` banner and the `--agent` argument the launch passed, so the row is
 * greppable straight back to the session and its definition file. A pre-numeric
 * UUID id renders in full; truncating it would invent a name no terminal shows.
 * The Manager keeps one fixed name per workspace, so its row is just "Manager".
 */
function agentLabel(session: AgentSession): string {
  if (session.identity.type === "manager") return "Manager";
  return `aboard-${session.identity.type}-${session.identity.agentId}`;
}
// Telemetry is deliberately absent from the tree: the counters are not wired to a
// reliable source yet, and a wrong number is worse than no number.
function agentTooltip(session: AgentSession, leaseHolder: boolean, terminalOpen: boolean, orphaned: boolean): string {
  return [
    `Session: ${session.sessionId}`,
    `Status: ${terminalOpen ? session.lifecycle.status : orphaned ? "interrupted after VS Code restart" : "paused after VS Code restart"}`,
    terminalOpen ? "" : orphaned
      ? "Cannot be restored: this automated task's result caller no longer exists. Use Remove Interrupted Session."
      : "Use Restore Fleet to reopen this Claude conversation",
    leaseHolder ? "Holds the write lease" : "",
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
