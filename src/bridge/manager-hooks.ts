import type { AgentId, AgentSession, IsoTimestamp, WorkerResult } from "../domain/contracts.js";
import type { FleetRegistry, MailboxEntry } from "../domain/fleet.js";
import type { WriteLease } from "../domain/lease.js";
import type { DelegationLaunchInput } from "./delegation.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";

export const HOOK_OUTPUT_LIMIT = 10_000;
export const MANAGER_SESSION_START_TIMEOUT_SECONDS = 120;
export const MANAGER_STOP_TIMEOUT_SECONDS = 3_600;
export const MANAGER_PROMPT_TIMEOUT_SECONDS = 60;

/**
 * The Manager's session-start orientation.
 *
 * One hook, one block. Four separate slices cost four `uv` process spawns and
 * four bridge round trips to deliver four unlabeled `additionalContext`
 * fragments; the Manager then had to reassemble them into a picture of the
 * project. Fetching them together also lets the slow boundaries — git and
 * GitHub — overlap instead of running in series.
 *
 * The content rule is that a fact the Manager would otherwise spend a turn
 * fetching belongs here. Issue titles, not bare numbers; the roadmap body, not
 * a pointer to a tool that returns it. `--agent` replaces Claude Code's own
 * system prompt (`docs/CLAUDE-REFERENCES/subagents.md`), which takes the
 * environment and git-status blocks with it, so the repository card restores
 * the orientation every other Claude Code session starts with.
 */
export const ROADMAP_BODY_LIMIT = 2_000;
const ISSUE_LIST_LIMIT = 15;

export type BriefingDisposition = "afk" | "hitl" | "unclassified";

export interface BriefingIssue {
  readonly number: number;
  readonly title: string;
  readonly disposition: BriefingDisposition;
  /** Open issues this one waits on. Empty means ready to start. */
  readonly blockedBy: readonly number[];
}

export interface RepositoryBriefing {
  readonly name: string;
  readonly defaultBranch: string;
  /** The project's own baseline commands, in the order a worker should run them. */
  readonly checks: readonly string[];
}

export interface GitBriefingState {
  readonly branch: string;
  readonly head: string;
  readonly dirty: boolean;
}

export interface GitHubBriefingState {
  readonly issues: readonly BriefingIssue[];
  readonly openPullRequests: readonly {
    readonly number: number;
    readonly title: string;
    readonly reviewState: string;
  }[];
  readonly unreviewedMergeCount: number;
}

export interface RoadmapBriefing {
  readonly number: number;
  readonly body: string;
}

/** What the auto-run engine is doing, flattened to the facts that change advice. */
export interface AutoRunBriefing {
  readonly specNumber: number;
  readonly specTitle: string;
  readonly phase: string;
  readonly currentIssue: number | undefined;
  readonly completedCount: number;
  /** The pull request a `hitl` issue is parked on, when the run is waiting. */
  readonly waitingOnPullRequest?: number | undefined;
}

export interface BriefingSources {
  repository(signal: AbortSignal): Promise<RepositoryBriefing>;
  git(signal: AbortSignal): Promise<GitBriefingState>;
  github(signal: AbortSignal): Promise<GitHubBriefingState>;
  roadmap(signal: AbortSignal): Promise<RoadmapBriefing | undefined>;
  autoRun(): AutoRunBriefing | undefined;
}

export interface BriefingFileStore {
  write(slice: "state", content: string): Promise<string>;
}

function active(session: AgentSession): boolean {
  return session.lifecycle.status === "starting" || session.lifecycle.status === "running" || session.lifecycle.status === "awaiting-user";
}

function boundedPreview(content: string, path: string): string {
  const suffix = `\nFull briefing: ${path}\n</aboard-state>`;
  // Hook output is read by a TUI, so the truncation marker stays ASCII.
  return `${content.slice(0, Math.max(0, HOOK_OUTPUT_LIMIT - suffix.length - 3))}...${suffix}`;
}

/** One failing boundary costs its own section, never the whole block. */
async function section(
  heading: string,
  signal: AbortSignal,
  render: () => Promise<string> | string,
): Promise<string> {
  try {
    const body = (await render()).trim();
    return body.length === 0 ? "" : `## ${heading}\n${body}`;
  } catch (error) {
    const reason = signal.aborted
      ? "the request was cancelled or timed out"
      : error instanceof Error ? error.message : "boundary failure";
    return `## ${heading}\nUnavailable: ${reason}. Re-derive it yourself before acting on it.`;
  }
}

function issueLine(issue: BriefingIssue): string {
  const waits = issue.blockedBy.length === 0
    ? ""
    : ` - waits on ${issue.blockedBy.map((number) => `#${number}`).join(", ")}`;
  return `#${issue.number} ${issue.title} (${issue.disposition})${waits}`;
}

function list(issues: readonly BriefingIssue[]): string {
  const shown = issues.slice(0, ISSUE_LIST_LIMIT).map(issueLine);
  const omitted = issues.length - shown.length;
  if (omitted > 0) shown.push(`...and ${omitted} more; list them with \`gh issue list\` if you need them.`);
  return shown.join("\n");
}

export class ManagerBriefings {
  public constructor(
    private readonly sources: BriefingSources,
    private readonly fleet: FleetRegistry,
    private readonly lease: WriteLease,
    private readonly files?: BriefingFileStore,
  ) {}

  public async render(signal: AbortSignal): Promise<string> {
    // Independent boundaries, so they overlap. A slow `gh` call no longer adds
    // its latency to a slow `git` call.
    const [repository, work, fleet, roadmap] = await Promise.all([
      this.#repository(signal),
      this.#work(signal),
      section("Fleet", signal, () => this.#fleet()),
      section("Roadmap", signal, () => this.#roadmap(signal)),
    ]);

    const content = [
      "<aboard-state>",
      "A snapshot taken at session start, not a live view. Re-check anything you are about to act on.",
      repository,
      section("Auto-run", signal, () => this.#autoRun()),
      work,
      fleet,
      roadmap,
      "</aboard-state>",
    ];
    const rendered = (await Promise.all(content)).filter((part) => part.length > 0).join("\n\n");
    if (rendered.length <= HOOK_OUTPUT_LIMIT) return rendered;
    if (this.files === undefined) return rendered.slice(0, HOOK_OUTPUT_LIMIT);
    return boundedPreview(rendered, await this.files.write("state", rendered));
  }

  async #repository(signal: AbortSignal): Promise<string> {
    return section("Repository", signal, async () => {
      const [repository, git] = await Promise.all([
        this.sources.repository(signal),
        this.sources.git(signal),
      ]);
      const checks = repository.checks.length === 0
        ? "no baseline checks are configured"
        : `verify with ${repository.checks.join(", ")}`;
      return [
        `${repository.name} | default branch ${repository.defaultBranch} | ${checks}`,
        `Checked out: ${git.branch} @ ${git.head}, working tree ${git.dirty ? "dirty" : "clean"}`,
      ].join("\n");
    });
  }

  /** Issues and pull requests read together: they are one question about work. */
  async #work(signal: AbortSignal): Promise<string> {
    let state: GitHubBriefingState;
    try {
      state = await this.sources.github(signal);
    } catch (error) {
      return await section("Work", signal, () => { throw error; });
    }
    const ready = state.issues.filter((issue) => issue.blockedBy.length === 0);
    const blocked = state.issues.filter((issue) => issue.blockedBy.length > 0);
    const parts = [
      `## Ready to implement\n${ready.length === 0 ? "Nothing is ready." : list(ready)}`,
    ];
    if (blocked.length > 0) parts.push(`## Blocked\n${list(blocked)}`);
    const pullRequests = state.openPullRequests
      .map((pr) => `#${pr.number} ${pr.title} (${pr.reviewState})`)
      .join("\n");
    const merges = state.unreviewedMergeCount === 0
      ? ""
      : `\n${state.unreviewedMergeCount} pull request(s) merged without review since your previous session.`;
    parts.push(`## Pull requests\n${pullRequests.length === 0 ? "None open." : pullRequests}${merges}`);
    return parts.join("\n\n");
  }

  #autoRun(): string {
    const run = this.sources.autoRun();
    if (run === undefined) return "No run is active. `/auto` starts one on the oldest open spec.";
    const lines = [
      `Running spec #${run.specNumber} "${run.specTitle}" - phase ${run.phase}, ${run.completedCount} issue(s) done.`,
    ];
    if (run.currentIssue !== undefined) lines.push(`Current issue: #${run.currentIssue}.`);
    if (run.waitingOnPullRequest !== undefined) {
      lines.push(`Paused: PR #${run.waitingOnPullRequest} is hitl and waiting for the user to merge it. Their merge resumes the run.`);
    }
    return lines.join("\n");
  }

  #fleet(): string {
    const holder = this.lease.current();
    const agents = this.fleet.list().filter(active).map((entry) => {
      const issue = entry.issueNumber === undefined ? "" : `, issue #${entry.issueNumber}`;
      const lease = holder?.agentId === entry.identity.agentId ? ", holds the write lease" : "";
      // The description is what the user sees in the fleet tree, so it is what
      // makes this list legible when the Manager relays it back to them.
      return `"${entry.terminal.name}" - ${entry.identity.type}, ${entry.lifecycle.status}${issue}${lease}`;
    });
    return agents.length === 0
      ? "No live agents. The write lease is unheld."
      : `${agents.join("\n")}\nWrite lease: ${holder === undefined ? "unheld" : holder.agentId}`;
  }

  async #roadmap(signal: AbortSignal): Promise<string> {
    const roadmap = await this.sources.roadmap(signal);
    if (roadmap === undefined) {
      return "No issue is labelled `ai:todo`. Write one with `aboard todo` when the project has a direction worth recording.";
    }
    const body = roadmap.body.trim();
    const bounded = body.length <= ROADMAP_BODY_LIMIT
      ? body
      : `${body.slice(0, ROADMAP_BODY_LIMIT).trimEnd()}\n\n...truncated. Read the rest with \`gh issue view ${roadmap.number}\`.`;
    return `Issue #${roadmap.number} - the full body follows, so do not fetch it again.\n\n${bounded}`;
  }
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
    return joined.length <= this.#maxContextChars ? joined : joined.slice(0, this.#maxContextChars);
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

export interface InvokingTerminalKiller {
  kill(terminalId: AgentSession["terminal"]["terminalId"]): void;
}

/** The extension-owned actions `/auto` and `/review-pr` trigger. */
export interface ManagerCommandActions {
  startAutoRun(): Promise<unknown>;
  reviewPullRequest(): Promise<unknown>;
}

export class ManagerPromptService {
  readonly #now: () => Date;

  public constructor(
    private readonly fleet: FleetRegistry,
    private readonly launcher: InteractiveManagerLauncher,
    now?: () => Date,
    private readonly actions?: ManagerCommandActions,
    private readonly terminals?: InvokingTerminalKiller,
  ) {
    this.#now = now ?? (() => new Date());
  }

  public async handle(agentId: AgentId, prompt: string): Promise<Record<string, unknown>> {
    const done = parseDoneCommand(prompt);
    if (done !== undefined) return this.#done(agentId, done);
    const action = parseActionCommand(prompt);
    if (action !== undefined) return this.#runAction(agentId, action);
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
    const event = command.type === "general-purpose"
      ? `you started a general-purpose session (agent ${launchedAgentId}).`
      : `you started a brainstormer (agent ${launchedAgentId}).`;
    this.fleet.enqueueNotification(agentId, event, occurredAt);
    const opened = command.type === "general-purpose" ? "General-purpose session launched and focused." : "Brainstorm session launched and focused.";
    return {
      intercepted: true,
      message: command.ignoredArguments
        ? `${opened} It takes no arguments, so the text you typed after /${command.command} was not sent; type it in the new terminal.`
        : opened,
    };
  }

  #done(agentId: AgentId, command: ParsedDoneCommand): Record<string, unknown> {
    const session = this.fleet.get(agentId);
    if (session === undefined || this.terminals === undefined) {
      return { intercepted: true, message: "aboard could not close this terminal right now." };
    }
    try {
      this.terminals.kill(session.terminal.terminalId);
      return {
        intercepted: true,
        message: command.ignoredArguments
          ? "/done closes this terminal; the text you typed after it was not sent."
          : "Closing this terminal.",
      };
    } catch (error) {
      return { intercepted: true, message: `aboard could not close this terminal: ${error instanceof Error ? error.message : "the terminal action failed"}.` };
    }
  }

  /**
   * `/auto` and `/review-pr` are thin triggers for extension behavior, so the
   * bridge performs them and tells the user directly. Waking the Manager to
   * narrate a mechanical action costs a turn and risks it acting on the command
   * a second time; it is told what happened in the next prompt's drain instead.
   */
  async #runAction(agentId: AgentId, action: ParsedActionCommand): Promise<Record<string, unknown>> {
    if (this.actions === undefined) {
      return { intercepted: true, message: `aboard cannot handle /${action.command} right now: the extension action is unavailable.` };
    }
    let outcome: unknown;
    try {
      outcome = action.type === "auto" ? await this.actions.startAutoRun() : await this.actions.reviewPullRequest();
    } catch (error) {
      return { intercepted: true, message: `aboard could not run /${action.command}: ${error instanceof Error ? error.message : "the action failed"}.` };
    }
    const summary = describeActionOutcome(action.type, outcome);
    const occurredAt = this.#now().toISOString() as IsoTimestamp;
    this.fleet.enqueueNotification(agentId, `you ran /${action.command}: ${summary}`, occurredAt);
    return {
      intercepted: true,
      message: action.ignoredArguments
        ? `${summary} /${action.command} takes no arguments, so the text you typed after it was not sent.`
        : summary,
    };
  }
}

function describeActionOutcome(type: ParsedActionCommand["type"], outcome: unknown): string {
  if (typeof outcome !== "object" || outcome === null) {
    return type === "auto" ? "auto-run triggered." : "reopened the session for the open pull request.";
  }
  const value = outcome as Record<string, unknown>;
  if (type === "auto") {
    if (value.started === false) return `auto-run did not start: ${typeof value.reason === "string" ? value.reason : "no reason given"}.`;
    const spec = value.spec as { number?: unknown; title?: unknown } | undefined;
    const issues = Array.isArray(value.issues) ? value.issues.length : 0;
    return `auto-run started on spec #${String(spec?.number ?? "?")} with ${issues} issue${issues === 1 ? "" : "s"}.`;
  }
  switch (value.action) {
    case "none": return "No pull request is open, so nothing was launched.";
    case "focused": return `Focused the ${String(value.type)} terminal for PR #${String(value.prNumber)}.`;
    case "resumed": return `Resumed the ${String(value.type)} session for PR #${String(value.prNumber)}.`;
    case "launched": return String(value.notice ?? `Launched a reviewer for PR #${String(value.prNumber)}.`);
    default: return "Reopened the session for the open pull request.";
  }
}

interface ParsedActionCommand {
  readonly type: "auto" | "review-pr";
  readonly command: string;
  readonly ignoredArguments: boolean;
}

interface ParsedDoneCommand {
  readonly ignoredArguments: boolean;
}

function parseDoneCommand(prompt: string): ParsedDoneCommand | undefined {
  const match = /^\s*\/done(?:\s+([\s\S]*?))?\s*$/.exec(prompt);
  if (match === null) return undefined;
  return { ignoredArguments: (match[1]?.trim() ?? "").length > 0 };
}

/**
 * Like `/brainstorm` and `/general-purpose`, these take no arguments. Trailing text is
 * matched and dropped rather than forwarded: leaking `/auto now please` into the
 * Manager's context is worse than declining to pass it on.
 */
function parseActionCommand(prompt: string): ParsedActionCommand | undefined {
  const match = /^\s*\/(auto|review-pr)(?:\s+([\s\S]*?))?\s*$/.exec(prompt);
  if (match === null) return undefined;
  const command = match[1] as "auto" | "review-pr";
  return { type: command, command, ignoredArguments: (match[2]?.trim() ?? "").length > 0 };
}

/**
 * `/brainstorm` and `/general-purpose` take no arguments: they open a terminal the user then
 * drives directly, so an opening message would only spend a turn before the
 * conversation starts. Trailing text is still matched rather than passed
 * through, because leaking `/brainstorm foo` into the Manager's context is worse
 * than declining to forward it.
 */
function parseInteractiveCommand(prompt: string): {
  readonly type: "brainstormer" | "general-purpose";
  readonly command: string;
  readonly ignoredArguments: boolean;
  readonly input: DelegationLaunchInput;
} | undefined {
  const match = /^\s*\/(brainstorm|general-purpose)(?:\s+([\s\S]*?))?\s*$/.exec(prompt);
  if (match === null) return undefined;
  const command = match[1] as "brainstorm" | "general-purpose";
  const ignoredArguments = (match[2]?.trim() ?? "").length > 0;
  return command === "general-purpose"
    ? { type: "general-purpose", command, ignoredArguments, input: { type: "general-purpose", description: "general purpose interactive session" } }
    : { type: "brainstormer", command, ignoredArguments, input: { type: "brainstormer", description: "interactive brainstorm session" } };
}

export function createManagerHookRoutes(briefings: ManagerBriefings, stop: ManagerStopService, prompts?: ManagerPromptService): BridgeRequestHandler {
  return async (request): Promise<BridgeResponse> => {
    if (request.method !== "POST") return protocolError(405, "invalid-request", "Method not allowed");
    if (request.url.pathname === "/hooks/manager/brief") {
      return { status: 200, body: { additionalContext: await briefings.render(request.signal) } };
    }
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
