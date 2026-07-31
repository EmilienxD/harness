import type { AgentId, AgentSession, IsoTimestamp, WorkerResult } from "../domain/contracts.js";
import type { FleetRegistry, MailboxEntry } from "../domain/fleet.js";
import type { WriteLease } from "../domain/lease.js";
import type { DelegationLaunchInput } from "./delegation.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";

export const HOOK_OUTPUT_LIMIT = 10_000;
export const MANAGER_SESSION_START_TIMEOUT_SECONDS = 120;
export const MANAGER_STOP_TIMEOUT_SECONDS = 3_600;
export const MANAGER_PROMPT_TIMEOUT_SECONDS = 60;

export type BriefingSlice = "git" | "github" | "fleet" | "todo";

export interface GitBriefingState {
  readonly branch: string;
  readonly head: string;
  readonly dirty: boolean;
}

export interface GitHubBriefingState {
  readonly readyIssues: readonly number[];
  readonly openPullRequests: readonly { readonly number: number; readonly reviewState: string }[];
  readonly hitlIssues: readonly number[];
  readonly unreviewedMergeCount: number;
}

export interface BriefingSources {
  git(signal: AbortSignal): Promise<GitBriefingState>;
  github(signal: AbortSignal): Promise<GitHubBriefingState>;
  todoIssue(signal: AbortSignal): Promise<number | undefined>;
}

export interface BriefingFileStore {
  write(slice: BriefingSlice, content: string): Promise<string>;
}

function active(session: AgentSession): boolean {
  return session.lifecycle.status === "starting" || session.lifecycle.status === "running" || session.lifecycle.status === "awaiting-user";
}

function boundedPreview(slice: BriefingSlice, content: string, path: string): string {
  const suffix = `\nFull ${slice} briefing: ${path}`;
  return `${content.slice(0, Math.max(0, HOOK_OUTPUT_LIMIT - suffix.length - 1))}…${suffix}`;
}

export class ManagerBriefings {
  public constructor(
    private readonly sources: BriefingSources,
    private readonly fleet: FleetRegistry,
    private readonly lease: WriteLease,
    private readonly files?: BriefingFileStore,
  ) {}

  public async render(slice: BriefingSlice, signal: AbortSignal): Promise<string> {
    let content: string;
    try {
      switch (slice) {
        case "git": {
          const state = await this.sources.git(signal);
          content = `Git: branch ${state.branch}; HEAD ${state.head}; working tree ${state.dirty ? "dirty" : "clean"}.`;
          break;
        }
        case "github": {
          const state = await this.sources.github(signal);
          const prs = state.openPullRequests.map((pr) => `#${pr.number} (${pr.reviewState})`).join(", ") || "none";
          content = [
            `GitHub: ready issues ${numbers(state.readyIssues)}.`,
            `Open PRs: ${prs}.`,
            `HITL waits: ${numbers(state.hitlIssues)}.`,
            `Merged without review since the previous session: ${state.unreviewedMergeCount}.`,
          ].join("\n");
          break;
        }
        case "fleet": {
          const agents = this.fleet.list().filter(active).map((entry) => {
            const issue = entry.issueNumber === undefined ? "" : ` issue #${entry.issueNumber}`;
            return `${entry.identity.agentId} (${entry.identity.type}, ${entry.lifecycle.status}${issue})`;
          });
          const holder = this.lease.current();
          content = `Fleet: ${agents.join(", ") || "no live agents"}.\nWrite lease: ${holder?.agentId ?? "unheld"}.`;
          break;
        }
        case "todo": {
          const issue = await this.sources.todoIssue(signal);
          content = issue === undefined
            ? "Project TODO issue was not found."
            : `Project TODO is issue #${issue}. Read it with mcp__aboard__get_todo when you need it.`;
          break;
        }
      }
    } catch (error) {
      if (signal.aborted) return `${slice} briefing unavailable: request was cancelled or timed out.`;
      return `${slice} briefing unavailable: ${error instanceof Error ? error.message : "boundary failure"}.`;
    }
    if (content.length <= HOOK_OUTPUT_LIMIT) return content;
    if (this.files === undefined) return `${content.slice(0, HOOK_OUTPUT_LIMIT - 1)}…`;
    return boundedPreview(slice, content, await this.files.write(slice, content));
  }
}

function numbers(values: readonly number[]): string {
  return values.length === 0 ? "none" : values.map((value) => `#${value}`).join(", ");
}

export interface ManagerStopRequest {
  readonly agentId: AgentId;
  readonly stopHookActive: boolean;
}

export type ManagerStopPoll =
  | { readonly state: "idle" }
  | { readonly state: "running" }
  | { readonly state: "results"; readonly additionalContext: string };

export interface ManagerStopOptions {
  readonly fleet: FleetRegistry;
  readonly now?: () => Date;
  readonly waitForChange?: (signal: AbortSignal) => Promise<void>;
  readonly maxResults?: number;
  readonly maxContextChars?: number;
}

export class ManagerStopService {
  readonly #now: () => Date;
  readonly #maxResults: number;
  readonly #maxContextChars: number;
  public constructor(private readonly options: ManagerStopOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#maxResults = options.maxResults ?? 20;
    this.#maxContextChars = options.maxContextChars ?? 9_500;
  }

  public async poll(input: ManagerStopRequest, signal: AbortSignal): Promise<ManagerStopPoll> {
    if (input.stopHookActive) return { state: "idle" };
    while (!signal.aborted) {
      const at = this.#now().toISOString() as IsoTimestamp;
      const results = this.options.fleet.drainMailbox(input.agentId, at);
      if (results.length > 0) return { state: "results", additionalContext: this.#format(results, at) };
      if (!this.options.fleet.list().some((entry) => entry.resultDelivery.mode === "mailbox" && entry.resultDelivery.managerAgentId === input.agentId && active(entry))) {
        return { state: "idle" };
      }
      if (this.options.waitForChange === undefined) return { state: "running" };
      await this.options.waitForChange(signal);
    }
    return { state: "idle" };
  }

  #format(entries: readonly MailboxEntry[], deliveredAt: IsoTimestamp): string {
    const omitted = Math.max(0, entries.length - this.#maxResults);
    const selected = entries.slice(omitted);
    const lines = [`At ${deliveredAt}, aboard received ${entries.length} background result(s).`];
    if (omitted > 0) lines.push(`${omitted} older result(s) were omitted from this bounded batch.`);
    for (const entry of selected) lines.push(formatResult(entry.agentId, entry.result));
    const joined = lines.join("\n");
    return joined.length <= this.#maxContextChars ? joined : `${joined.slice(0, this.#maxContextChars - 1)}…`;
  }
}

function formatResult(agentId: AgentId, result: WorkerResult): string {
  return result.outcome === "succeeded"
    ? `${agentId} succeeded: ${result.lastAssistantMessage}`
    : `${agentId} failed (${result.failure.type}): ${result.failure.lastAssistantMessage ?? "no final message"}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export interface InteractiveManagerLauncher {
  spawnInteractive(input: DelegationLaunchInput): Promise<unknown>;
}

export class ManagerPromptService {
  readonly #now: () => Date;

  public constructor(
    private readonly fleet: FleetRegistry,
    private readonly launcher: InteractiveManagerLauncher,
    now?: () => Date,
  ) {
    this.#now = now ?? (() => new Date());
  }

  public async handle(agentId: AgentId, prompt: string): Promise<Record<string, unknown>> {
    const command = parseInteractiveCommand(prompt);
    if (command === undefined) {
      const deliveredAt = this.#now().toISOString() as IsoTimestamp;
      const delivery = this.fleet.drainNotifications(agentId, deliveredAt);
      if (delivery.notifications.length === 0 && delivery.summarized === undefined) return {};
      const lines = [`Since your last message (delivered at ${deliveredAt}):`];
      if (delivery.summarized !== undefined) {
        lines.push(
          `${delivery.summarized.count} earlier aboard action(s) occurred between ${delivery.summarized.firstOccurredAt} and ${delivery.summarized.lastOccurredAt}; details were summarized to keep this context bounded.`,
        );
      }
      for (const notification of delivery.notifications) {
        lines.push(`At ${notification.occurredAt}: ${notification.message}`);
      }
      return { additionalContext: lines.join("\n") };
    }

    const launched = await this.launcher.spawnInteractive(command.input) as Record<string, unknown>;
    const occurredAt = this.#now().toISOString() as IsoTimestamp;
    const launchedAgentId = typeof launched.agentId === "string" ? launched.agentId : "unknown";
    const event = command.type === "raw"
      ? `you started a raw session (agent ${launchedAgentId}).`
      : `you started a brainstormer${command.topic === undefined ? "" : ` on ${JSON.stringify(command.topic)}`} (agent ${launchedAgentId}).`;
    this.fleet.enqueueNotification(agentId, event, occurredAt);
    return { intercepted: true, message: command.type === "raw" ? "Raw session launched and focused." : "Brainstorm session launched and focused." };
  }
}

function parseInteractiveCommand(prompt: string): {
  readonly type: "brainstormer" | "raw";
  readonly topic?: string;
  readonly input: DelegationLaunchInput;
} | undefined {
  const match = /^\s*\/(brainstorm|raw)(?:\s+([\s\S]*?))?\s*$/.exec(prompt);
  if (match === null) return undefined;
  const topic = match[2]?.trim();
  if (match[1] === "raw") {
    return { type: "raw", input: { type: "raw", description: "raw interactive session", ...(topic ? { prompt: topic } : {}) } };
  }
  return {
    type: "brainstormer",
    ...(topic ? { topic } : {}),
    input: { type: "brainstormer", description: "interactive brainstorm session", ...(topic ? { prompt: topic } : {}) },
  };
}

export function createManagerHookRoutes(briefings: ManagerBriefings, stop: ManagerStopService, prompts?: ManagerPromptService): BridgeRequestHandler {
  return async (request): Promise<BridgeResponse> => {
    if (request.method !== "POST") return protocolError(405, "invalid-request", "Method not allowed");
    const brief = /^\/hooks\/manager\/brief-(git|github|fleet|todo)$/.exec(request.url.pathname);
    if (brief !== null) return { status: 200, body: { additionalContext: await briefings.render(brief[1] as BriefingSlice, request.signal) } };
    if (request.url.pathname === "/hooks/manager/stop") {
      const body = record(request.body);
      if (body === undefined || typeof body.agentId !== "string" || body.agentId.trim() === "" || typeof (body.stopHookActive ?? body.stop_hook_active) !== "boolean") {
        return protocolError(400, "invalid-request", "agentId and stopHookActive are required");
      }
      return { status: 200, body: await stop.poll({ agentId: body.agentId as AgentId, stopHookActive: (body.stopHookActive ?? body.stop_hook_active) as boolean }, request.signal) };
    }
    if (request.url.pathname === "/hooks/manager/prompt" && prompts !== undefined) {
      const body = record(request.body);
      if (body === undefined || typeof body.agentId !== "string" || body.agentId.trim() === "" || typeof body.prompt !== "string") {
        return protocolError(400, "invalid-request", "agentId and prompt are required");
      }
      try {
        return { status: 200, body: await prompts.handle(body.agentId as AgentId, body.prompt) };
      } catch (error) {
        return protocolError(error instanceof Error && "code" in error && error.code === "lease-conflict" ? 409 : 500, error instanceof Error && "code" in error && error.code === "lease-conflict" ? "conflict" : "internal-error", error instanceof Error ? error.message : "Interactive launch failed");
      }
    }
    return protocolError(404, "not-found", "Route not found");
  };
}
