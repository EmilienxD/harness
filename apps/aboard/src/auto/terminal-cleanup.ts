import type { TerminalSnapshot } from "../platform/terminals.js";
import type { FleetRegistry } from "../domain/fleet.js";
import type { IsoTimestamp, TerminalId } from "../domain/contracts.js";

export interface AutoRunTerminalController {
  get(terminalId: TerminalId): TerminalSnapshot;
  kill(terminalId: TerminalId): void;
}

export function closeSettledAutoRunTerminal(
  terminals: AutoRunTerminalController,
  fleet: FleetRegistry,
  terminalId: TerminalId,
  now: () => Date = () => new Date(),
): void {
  const terminal = terminals.get(terminalId);
  if (terminal.status === "open") terminals.kill(terminalId);
  const session = fleet.get(terminal.agentId);
  if (session === undefined || session.sessionId !== terminal.sessionId) return;
  if (session.lifecycle.status !== "completed" && session.lifecycle.status !== "failed") return;
  fleet.remove(session.identity.agentId, now().toISOString() as IsoTimestamp);
}
