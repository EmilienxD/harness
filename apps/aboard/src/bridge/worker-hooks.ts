import type { AgentId, IsoTimestamp } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import { describeIssueNumbers } from "../shared/issues.js";
import type { BridgeRequestHandler } from "./protocol.js";
import { protocolError } from "./protocol.js";

export interface WorkerTaskSource {
  task(agentId: AgentId): Promise<{ readonly path: string; readonly contents: string } | undefined>;
}

/** Internal Auto Run hooks only; in-process agent telemetry is intentionally unmanaged. */
export class WorkerHookService {
  public constructor(
    private readonly fleet: FleetRegistry,
    private readonly tasks: WorkerTaskSource = { task: async () => undefined },
    private readonly now: () => Date = () => new Date(),
  ) {}

  public compact(agentId: AgentId, summary: string): void {
    this.fleet.recordCompaction(agentId, summary, this.timestamp());
  }

  public async reground(agentId: AgentId): Promise<string> {
    const worker = this.fleet.get(agentId);
    if (worker === undefined || worker.issueNumbers === undefined || worker.issueNumbers.length === 0) {
      throw new Error("Compaction re-grounding requires a registered issue-bound worker");
    }
    const continuation = `Continue addressing ${describeIssueNumbers(worker.issueNumbers)} from where you stopped.`;
    const task = await this.tasks.task(agentId);
    return task === undefined ? continuation : `${continuation}\n\nReminder: full task is in @${task.path}; follow it.\n\n${task.contents.trim()}`;
  }

  private timestamp(): IsoTimestamp {
    return this.now().toISOString() as IsoTimestamp;
  }
}

export function createWorkerHookRoutes(service: WorkerHookService): BridgeRequestHandler {
  return async (request) => {
    if (request.method !== "POST" || !request.url.pathname.startsWith("/hooks/worker/")) {
      return protocolError(404, "not-found", "Route not found");
    }
    try {
      const body = object(request.body);
      const agentId = requiredString(body.agentId, "agentId") as AgentId;
      switch (request.url.pathname) {
        case "/hooks/worker/post-compact":
          service.compact(agentId, requiredString(body.compactSummary, "compactSummary"));
          return { status: 200, body: { ok: true } };
        case "/hooks/worker/reground":
          return { status: 200, body: { ok: true, additionalContext: await service.reground(agentId) } };
        default:
          return protocolError(404, "not-found", "Route not found");
      }
    } catch (error) {
      return protocolError(400, "invalid-request", error instanceof Error ? error.message : "Invalid worker hook event");
    }
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Request body must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}
