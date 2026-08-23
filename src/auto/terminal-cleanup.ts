import type { TerminalSnapshot } from "../claude/terminals.js";
import type { FleetRegistry } from "../domain/fleet.js";
import type { IsoTimestamp, TerminalId } from "../domain/contracts.js";

export interface AutoRunTerminalController {
  get(terminalId: TerminalId): TerminalSnapshot;
  kill(terminalId: TerminalId): void;
}

/**
 * Closes a terminal auto-run has finished with and retires its settled fleet
 * row. The engine calls this only after receiving the worker's result, so no
 * result delivery is lost; an interactive doctor that is still running is
 * left for the ordinary terminal-close lifecycle path to settle.
 */
export function closeSettledAutoRunTerminal(
  terminals: AutoRunTerminalController,
  fleet: FleetRegistry,
  terminalId: TerminalId,
  now: () => Date = () => new Date(),
): void {
  const terminal = terminals.get(terminalId);
  // The user may have closed it in the small interval between result delivery
  // and issue cleanup. That already satisfies the terminal postcondition; the
  // settled fleet record still needs retiring.
  if (terminal.status === "open") terminals.kill(terminalId);
  const session = fleet.get(terminal.agentId);
  if (session === undefined || session.sessionId !== terminal.sessionId) return;
  if (session.lifecycle.status !== "completed" && session.lifecycle.status !== "failed") return;
  fleet.remove(session.identity.agentId, now().toISOString() as IsoTimestamp);
}
