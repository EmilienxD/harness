import type { AgentId, AgentSession, ChildAgentNode, IsoTimestamp, TerminalId, WorkerFailureType } from "../domain/contracts.js";
import type { FleetEvent, FleetRegistry } from "../domain/fleet.js";
import type { LeaseAuditEvent, WriteLease } from "../domain/lease.js";

export type FleetTreeNode =
  | { readonly kind: "agent"; readonly session: AgentSession; readonly leaseHolder: boolean }
  | { readonly kind: "child"; readonly child: ChildAgentNode };

export interface FleetTreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly contextValue: "aboard.agent.active" | "aboard.agent.finished" | "aboard.child";
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
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#fleetRegistration = fleet.onDidChange(() => host.refresh());
    this.#leaseRegistration = lease.onDidChange(() => host.refresh());
  }

  public roots(): readonly FleetTreeNode[] {
    return this.fleet.list().filter((entry) => entry.identity.type === "manager").concat(
      this.fleet.list().filter((entry) => entry.identity.type !== "manager"),
    ).map((session) => ({ kind: "agent", session, leaseHolder: this.lease.current()?.agentId === session.identity.agentId }));
  }

  public children(node: FleetTreeNode): readonly FleetTreeNode[] {
    if (node.kind === "child") return [];
    return this.fleet.listChildren(node.session.identity.agentId).map((child) => ({ kind: "child", child }));
  }

  public item(node: FleetTreeNode): FleetTreeItem {
    if (node.kind === "child") {
      const telemetry = formatTelemetry(node.child.telemetry.totalTokens, node.child.telemetry.totalToolUseCount);
      return { label: node.child.type, description: [node.child.status, telemetry].filter(Boolean).join(" · "), tooltip: childTooltip(node.child), contextValue: "aboard.child", collapsible: false };
    }
    const { session } = node;
    const goal = session.issueNumber === undefined ? "" : ` #${session.issueNumber}`;
    const elapsed = formatElapsed(session.lifecycle.startedAt, this.now());
    const markers = [session.lifecycle.status, node.leaseHolder ? "lease holder" : "", elapsed, session.telemetry.compactionCount > 0 ? `compacted ×${session.telemetry.compactionCount}` : ""].filter(Boolean);
    const active = ["starting", "running", "awaiting-user"].includes(session.lifecycle.status);
    return {
      label: `${session.identity.type === "manager" ? "Manager" : session.identity.type}${goal}`,
      description: markers.join(" · "),
      tooltip: agentTooltip(session, node.leaseHolder),
      contextValue: active ? "aboard.agent.active" : "aboard.agent.finished",
      collapsible: this.fleet.listChildren(session.identity.agentId).length > 0,
      command: { command: "aboard.focusAgent", title: "Focus Agent", arguments: [node] },
    };
  }

  public dispose(): void { this.#fleetRegistration.dispose(); this.#leaseRegistration.dispose(); }
}

export interface AgentCommandHost {
  register(command: string, callback: (...args: readonly unknown[]) => unknown): { dispose(): void };
  input(prompt: string): Promise<string | undefined>;
  confirm(message: string, action: string): Promise<boolean>;
  info(message: string): void;
  error(message: string): void;
}

export interface AgentTerminalActions {
  show(terminalId: TerminalId): void;
  kill(terminalId: TerminalId): void;
  sendUserTakeoverText(terminalId: TerminalId, text: string, addNewLine?: boolean): void;
}

export function registerFleetCommands(host: AgentCommandHost, terminals: AgentTerminalActions, fleet: FleetRegistry, lease: WriteLease, now: () => Date = () => new Date()): { dispose(): void } {
  const sessionOf = (value: unknown): AgentSession | undefined => isAgentNode(value) ? value.session : undefined;
  const registrations = [
    host.register("aboard.focusAgent", (value) => { const session = sessionOf(value); if (session) terminals.show(session.terminal.terminalId); }),
    host.register("aboard.sendAgent", async (value) => { const session = sessionOf(value); if (!session) return; const text = await host.input(`Message ${session.identity.type}`); if (text?.trim()) terminals.sendUserTakeoverText(session.terminal.terminalId, text, true); }),
    host.register("aboard.killAgent", async (value) => { const session = sessionOf(value); if (session && await host.confirm(`Kill ${session.identity.type}?`, "Kill")) terminals.kill(session.terminal.terminalId); }),
    host.register("aboard.resumeAgent", (value) => { const session = sessionOf(value); if (session) terminals.show(session.terminal.terminalId); }),
    host.register("aboard.forceReleaseLease", async () => { const holder = lease.current(); if (holder === undefined) return host.info("No write lease is held."); if (await host.confirm(`Force release the write lease held by ${holder.agentId}?`, "Release")) lease.forceRelease(now().toISOString() as IsoTimestamp, "user force release from VS Code"); }),
  ];
  return { dispose: () => registrations.forEach((entry) => entry.dispose()) };
}

function isAgentNode(value: unknown): value is Extract<FleetTreeNode, { kind: "agent" }> { return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "agent"; }
function formatElapsed(startedAt: IsoTimestamp, now: Date): string { const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function formatTelemetry(tokens: number, tools: number): string { return tokens === 0 && tools === 0 ? "" : `${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok · ${tools} tools`; }
function agentTooltip(session: AgentSession, leaseHolder: boolean): string { return [`Session: ${session.sessionId}`, `Lifecycle: ${session.lifecycle.status}`, `Tokens: ${session.telemetry.totalTokens}`, `Tool uses: ${session.telemetry.totalToolUseCount}`, `Compactions: ${session.telemetry.compactionCount}`, leaseHolder ? "Holds the write lease" : ""].filter(Boolean).join("\n"); }
function childTooltip(child: ChildAgentNode): string { return [`Type: ${child.type}`, `Status: ${child.status}`, `Tokens: ${child.telemetry.totalTokens}`, `Tool uses: ${child.telemetry.totalToolUseCount}`].join("\n"); }

export interface FleetNotificationHost { information(message: string): void; warning(message: string): void; error(message: string): void; }
export class FleetNotifications {
  readonly #fleetRegistration: { dispose(): void };
  public constructor(fleet: FleetRegistry, private readonly host: FleetNotificationHost) {
    this.#fleetRegistration = fleet.onDidChange((event) => notify(event, fleet, host));
  }
  public leaseConflict(holder: AgentId, acquiredAt: IsoTimestamp): void { this.host.warning(`Write lease conflict: ${holder} has held the lease since ${acquiredAt}.`); }
  public permissionRisk(): void { this.host.warning("Unattended workers may stall on permission prompts. For afk work, use bypass permission mode."); }
  public scaffoldConflict(message: string): void { this.host.warning(message); }
  public dispose(): void { this.#fleetRegistration.dispose(); }
}

function notify(event: FleetEvent, fleet: FleetRegistry, host: FleetNotificationHost): void {
  if (event.type !== "lifecycle-transitioned" || (event.to !== "completed" && event.to !== "failed")) return;
  const session = fleet.get(event.agentId);
  // The Manager is the user's own console: its ending is something they did, not
  // a background result worth a toast.
  if (session?.identity.type === "manager") return;
  if (session?.lifecycle.status === "completed") host.information(`${session.identity.type} completed${session.issueNumber === undefined ? "" : ` issue #${session.issueNumber}`}.`);
  else if (session?.lifecycle.status === "failed") host.error(`${session.identity.type} failed: ${failureLabel(session.lifecycle.failure.type)}.`);
}
function failureLabel(type: WorkerFailureType): string { return type.replaceAll("-", " "); }

export interface FleetStatusSnapshot { readonly text: string; readonly tooltip: string; readonly liveAgentCount: number; }
export function renderFleetStatus(port: number, fleet: FleetRegistry, lease: WriteLease): FleetStatusSnapshot {
  const live = fleet.list().filter((entry) => ["starting", "running", "awaiting-user"].includes(entry.lifecycle.status));
  const holder = lease.current()?.agentId;
  return { text: `$(organization) ${live.length} · :${port}${holder === undefined ? "" : ` · $(lock) ${holder}`}`, tooltip: `aboard bridge: 127.0.0.1:${port}\nLive agents: ${live.length}\nWrite lease: ${holder ?? "free"}`, liveAgentCount: live.length };
}

export function saveLeaseWarning(lease: WriteLease): string | undefined {
  const holder = lease.current();
  return holder === undefined ? undefined : `You saved a file while ${holder.agentId} holds the aboard write lease. Your edit was saved, but concurrent changes may conflict.`;
}
