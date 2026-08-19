import type { AgentId, AgentTelemetry, AgentTokenUsage, IsoTimestamp } from "../domain/contracts.js";
import type { FleetRegistry } from "../domain/fleet.js";
import { ProcessGitClient, type GitClient } from "../git/client.js";
import { describeIssueNumbers } from "../shared/issues.js";
import type { BridgeRequestHandler } from "./protocol.js";
import { protocolError } from "./protocol.js";

const EMPTY_TELEMETRY: AgentTelemetry = { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 };

export interface WorkerBranchResolver { current(cwd: string): Promise<string>; }
export class GitWorkerBranchResolver implements WorkerBranchResolver {
  public constructor(private readonly client: (cwd: string) => GitClient = (cwd) => new ProcessGitClient(cwd)) {}

  public async current(cwd: string): Promise<string> {
    const branch = await this.client(cwd).currentBranch();
    if (branch === undefined) throw new Error("Worker is not on a named branch");
    return branch;
  }
}

export class WorkerHookService {
  public constructor(private readonly fleet: FleetRegistry, private readonly branches: WorkerBranchResolver = new GitWorkerBranchResolver(), private readonly now: () => Date = () => new Date()) {}

  public start(parentAgentId: AgentId, childAgentId: string, type: string): void {
    const at = this.timestamp();
    this.fleet.startChild({ agentId: childAgentId, parentAgentId, type, status: "running", startedAt: at, telemetry: EMPTY_TELEMETRY }, at);
  }

  public stop(parentAgentId: AgentId, childAgentId: string, result?: string): void {
    this.fleet.finishChild(parentAgentId, childAgentId, result, this.timestamp());
  }

  public agentTool(parentAgentId: AgentId, response: Record<string, unknown>): void {
    const childAgentId = requiredString(response.agentId, "tool_response.agentId");
    const current = this.fleet.listChildren(parentAgentId).find((child) => child.agentId === childAgentId);
    if (current === undefined) throw new Error(`Child agent ${childAgentId} is not registered for ${parentAgentId}`);
    const resolvedModel = optionalString(response.resolvedModel);
    const usage = parseUsage(response.usage);
    const telemetry: AgentTelemetry = {
      totalTokens: optionalInteger(response.totalTokens) ?? current.telemetry.totalTokens,
      totalDurationMs: optionalInteger(response.totalDurationMs) ?? current.telemetry.totalDurationMs,
      totalToolUseCount: optionalInteger(response.totalToolUseCount) ?? current.telemetry.totalToolUseCount,
      compactionCount: current.telemetry.compactionCount,
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      ...(usage === undefined ? {} : { usage }),
    };
    this.fleet.updateChildTelemetry(parentAgentId, childAgentId, telemetry, contentText(response.content), this.timestamp());
  }

  public compact(parentAgentId: AgentId, summary: string): void { this.fleet.recordCompaction(parentAgentId, summary, this.timestamp()); }

  public async reground(parentAgentId: AgentId, cwd: string): Promise<string> {
    const worker = this.fleet.get(parentAgentId);
    if (worker === undefined || worker.identity.type === "manager" || worker.issueNumbers === undefined || worker.issueNumbers.length === 0) {
      throw new Error("Compaction re-grounding requires a registered issue-bound worker");
    }
    const branch = await this.branches.current(cwd);
    const contract = worker.issueNumbers.length === 1 ? "resolved issue and spec" : "resolved issues and specs";
    return `You are aboard worker ${parentAgentId}, addressing ${describeIssueNumbers(worker.issueNumbers)} on branch ${branch}. Continue from the ${contract} supplied in your first message. If that contract is no longer available after compaction, stop and report that plainly; do not fetch it with gh.`;
  }

  private timestamp(): IsoTimestamp { return this.now().toISOString() as IsoTimestamp; }
}

export function createWorkerHookRoutes(service: WorkerHookService): BridgeRequestHandler {
  return async (request) => {
    if (request.method !== "POST" || !request.url.pathname.startsWith("/hooks/worker/")) {
      return protocolError(404, "not-found", "Route not found");
    }
    try {
      const body = object(request.body); const parent = requiredString(body.parentAgentId, "parentAgentId") as AgentId;
      switch (request.url.pathname) {
        case "/hooks/worker/subagent-start": service.start(parent, requiredString(body.childAgentId, "childAgentId"), requiredString(body.agentType, "agentType")); return { status: 200, body: { ok: true } };
        case "/hooks/worker/subagent-stop": service.stop(parent, requiredString(body.childAgentId, "childAgentId"), optionalString(body.result)); return { status: 200, body: { ok: true } };
        case "/hooks/worker/agent-tool": service.agentTool(parent, object(body.toolResponse)); return { status: 200, body: { ok: true } };
        case "/hooks/worker/post-compact": service.compact(parent, requiredString(body.compactSummary, "compactSummary")); return { status: 200, body: { ok: true } };
        case "/hooks/worker/reground": return { status: 200, body: { ok: true, additionalContext: await service.reground(parent, requiredString(body.cwd, "cwd")) } };
        default: return protocolError(404, "not-found", "Route not found");
      }
    } catch (error) { return protocolError(400, "invalid-request", error instanceof Error ? error.message : "Invalid worker hook event"); }
  };
}

function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Request body must be an object"); return value as Record<string, unknown>; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function optionalInteger(value: unknown): number | undefined { if (value === undefined) return undefined; if (!Number.isInteger(value) || (value as number) < 0) throw new Error("Telemetry values must be non-negative integers"); return value as number; }
function parseUsage(value: unknown): AgentTokenUsage | undefined { if (value === undefined) return undefined; const usage = object(value); const inputTokens = optionalInteger(usage.input_tokens); const outputTokens = optionalInteger(usage.output_tokens); const cacheCreationInputTokens = optionalInteger(usage.cache_creation_input_tokens); const cacheReadInputTokens = optionalInteger(usage.cache_read_input_tokens); return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }), ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }) }; }
function contentText(value: unknown): string | undefined { if (!Array.isArray(value)) return undefined; const text = value.flatMap((item) => typeof item === "object" && item !== null && "text" in item && typeof item.text === "string" ? [item.text] : []); return text.length === 0 ? undefined : text.join("\n"); }
