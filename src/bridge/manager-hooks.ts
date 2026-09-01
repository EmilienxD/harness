import type { AgentId, AgentSession, IsoTimestamp, WorkerResult } from "../domain/contracts.js";
import { renderTasks, type RoadmapTask } from "../domain/roadmap.js";
import type { FleetRegistry, ReportEntry } from "../domain/fleet.js";
import type { WriteLease } from "../domain/lease.js";
import type { AutoRunDryRunResult } from "../domain/auto-run.js";
import { describeIssueNumbers } from "../shared/issues.js";
import { describeReopenOutcome, type ReopenOutcome } from "../claude/reopen.js";
import type { DelegationLaunchInput } from "./delegation.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";

export const HOOK_OUTPUT_LIMIT = 10_000;
export const MANAGER_SESSION_START_TIMEOUT_SECONDS = 120;
export const MANAGER_STOP_TIMEOUT_SECONDS = 86_400;
export const MANAGER_PROMPT_TIMEOUT_SECONDS = 60;

export const ROADMAP_INLINE_LIMIT = 6_000;
const ISSUE_LIST_LIMIT = 15;

export const ROADMAP_MARKER = "<aboard-roadmap>";

export const ROADMAP_REMINDER_DEBOUNCE_MS = 30_000;

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
  readonly codebase?: CodebaseBriefing;
}

/** Source files and commits — see `CodebaseSurvey` in the git boundary. */
export interface CodebaseBriefing {
  readonly sourceFileCount: number;
  readonly languages: readonly string[];
  readonly commitCount: number;
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
  readonly tasks: readonly RoadmapTask[];
  /** Open issues carrying the label. More than one is reported, never repaired. */
  readonly carrierCount: number;
  readonly nearBound: boolean;
  readonly duplicateSubjects: readonly string[];
}

/** What the auto-run engine is doing, flattened to the facts that change advice. */
export interface AutoRunBriefing {
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
  write(slice: "state" | "roadmap", content: string): Promise<string>;
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

export function codebaseLine(codebase: CodebaseBriefing): string {
  const commits = codebase.commitCount === 1 ? "1 commit" : `${codebase.commitCount} commits`;
  if (codebase.sourceFileCount === 0) {
    return `Codebase: no source files, ${commits} - there is no code in this repository yet. `
      + "Nothing about the project can be derived from it, so a survey would come back empty and anything you would "
      + "otherwise learn by reading it has to come from the user instead.";
  }
  const languages = codebase.languages.length === 0 ? "" : ` (${codebase.languages.join(", ")})`;
  const unstarted = codebase.commitCount <= 1
    ? " - at most one commit, so this may be an untouched scaffold rather than a project in progress; confirm before treating its contents as decisions someone made"
    : "";
  return `Codebase: ${codebase.sourceFileCount} source files${languages}, ${commits}${unstarted}`;
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
        ...(repository.codebase === undefined ? [] : [codebaseLine(repository.codebase)]),
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
    if (run === undefined) return "No run is active. `/auto` starts one over every open [AI]-afk / [AI]-hitl issue, dependencies first and then oldest first.";
    const lines = [
      `Running - phase ${run.phase}, ${run.completedCount} issue(s) done.`,
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
      const issue = entry.issueNumbers === undefined ? "" : `, ${describeIssueNumbers(entry.issueNumbers)}`;
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
      return marked("No open issue carries `[AI]-todo`, so this project has no roadmap yet. That is the normal state of a fresh repository, not a deletion. Recommend `/update-todo` to the user: it works out what the first roadmap can be derived from, settles the rest with them, and writes it.");
    }
    const notes = roadmapNotes(roadmap);
    const inline = roadmapBlock(roadmap.tasks, "full", `Issue #${roadmap.number} - the whole roadmap follows, so do not fetch it again. The leading number is a task's position: pass it as \`task\`, with its subject as \`expect\`, to edit that task.`, notes);
    if (inline.length <= ROADMAP_INLINE_LIMIT || this.files === undefined) return inline;
    const path = await this.files.write("roadmap", inline);
    const heading = `Issue #${roadmap.number} - the full roadmap, completed history included, is pre-rendered with its positions at ${path}; one Read gets it. The head of the pending list follows inline.`;
    // What stays inline is the head of the pending list: the tasks most likely
    // to matter next, bounded so this section cannot grow past its share again.
    const pending = roadmap.tasks.filter((task) => !task.completed);
    const kept = bounded(pending, ROADMAP_INLINE_LIMIT - heading.length - notes.join("\n").length - 200);
    return roadmapBlock(kept, "full", heading, notes, pending.length - kept.length);
  }
}

/** As many tasks as fit the budget, with the omission stated rather than implied. */
function bounded(tasks: readonly RoadmapTask[], budget: number): readonly RoadmapTask[] {
  let used = 0;
  const kept: RoadmapTask[] = [];
  for (const task of tasks) {
    used += task.subject.length + 12;
    if (used > budget) break;
    kept.push(task);
  }
  return kept;
}

function marked(content: string): string {
  return `${ROADMAP_MARKER}\n${content}\n</aboard-roadmap>`;
}

/** Facts about the roadmap's condition that the Manager may need to act on. */
function roadmapNotes(roadmap: RoadmapBriefing): readonly string[] {
  const notes: string[] = [];
  if (roadmap.carrierCount > 1) notes.push(`${roadmap.carrierCount} issues carry \`[AI]-todo\`; #${roadmap.number} is in use.`);
  if (roadmap.duplicateSubjects.length > 0) notes.push(`Duplicate task text in the roadmap: ${roadmap.duplicateSubjects.map((subject) => `"${subject}"`).join(", ")}. Ask the user whether one should be removed.`);
  if (roadmap.nearBound) notes.push("The roadmap is near its size bound; consider asking the user about pruning completed items.");
  return notes;
}

function roadmapBlock(tasks: readonly RoadmapTask[], mode: "full" | "pending", heading: string, notes: readonly string[], omitted = 0): string {
  const list = renderTasks(tasks, mode);
  const parts = [...notes, heading, list.length === 0 ? "The roadmap issue exists but has no tasks yet." : list];
  if (omitted > 0) parts.push(`...and ${omitted} further pending task(s), in the file above.`);
  return marked(parts.join("\n\n"));
}

export function renderRoadmapReminder(roadmap: RoadmapBriefing | undefined, at: IsoTimestamp): string {
  if (roadmap === undefined) {
    return marked(`Roadmap as of ${at}: no open issue carries \`[AI]-todo\`, so there is still no roadmap. Recommend \`/update-todo\` when the project has a direction worth recording.`);
  }
  const pending = renderTasks(roadmap.tasks, "pending");
  const body = pending.length === 0
    ? `every task on issue #${roadmap.number} is complete.`
    : `pending tasks on issue #${roadmap.number}, with the positions to edit them by. The numbers are absolute over the whole roadmap, so they are not consecutive here. Completed history is unchanged and is not repeated.\n\n${pending}`;
  return marked(`Roadmap as of ${at} - ${body}`);
}

export interface RoadmapReminderSource {
  roadmap(signal: AbortSignal): Promise<RoadmapBriefing | undefined>;
}

export class RoadmapReminderService {
  readonly #served = new Map<AgentId, number>();
  readonly #now: () => Date;
  readonly #debounceMs: number;

  public constructor(
    private readonly source: RoadmapReminderSource,
    options: { readonly now?: () => Date; readonly debounceMs?: number } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#debounceMs = options.debounceMs ?? ROADMAP_REMINDER_DEBOUNCE_MS;
  }

  public async serve(agentId: AgentId, signal: AbortSignal): Promise<{ readonly additionalContext?: string }> {
    const at = this.#now();
    const previous = this.#served.get(agentId);
    if (previous !== undefined && at.getTime() - previous < this.#debounceMs) return {};
    this.#served.set(agentId, at.getTime());
    try {
      const roadmap = await this.source.roadmap(signal);
      return { additionalContext: renderRoadmapReminder(roadmap, at.toISOString() as IsoTimestamp) };
    } catch {
      return {};
    }
  }
}

export interface ManagerStopRequest {
  readonly agentId: AgentId;
  readonly stopHookActive: boolean;
  readonly lastAssistantMessage?: string;
}

export type ManagerStopPoll =
  | { readonly state: "idle" }
  | { readonly state: "running" }
  | { readonly state: "results"; readonly additionalContext: string };

export interface ManagerStopOptions {
  readonly fleet: FleetRegistry;
  readonly now?: () => Date;
  readonly waitForChange?: (signal: AbortSignal, afterRevision: number) => Promise<void>;
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
    if (input.lastAssistantMessage !== undefined) {
      this.options.fleet.observeAssistantMessage(input.agentId, input.lastAssistantMessage, this.#now().toISOString() as IsoTimestamp);
    }
    while (!signal.aborted) {
      const revision = this.options.fleet.revision();
      const at = this.#now().toISOString() as IsoTimestamp;
      const results = this.options.fleet.drainMailbox(input.agentId, at);
      if (results.length > 0) return { state: "results", additionalContext: this.#format(results, at) };
      if (this.options.fleet.reportsOwedTo(input.agentId).length === 0) {
        return { state: "idle" };
      }
      if (this.options.waitForChange === undefined) return { state: "running" };
      await this.options.waitForChange(signal, revision);
    }
    return { state: "idle" };
  }

  public deliver(agentId: AgentId): { readonly additionalContext?: string } {
    const at = this.#now().toISOString() as IsoTimestamp;
    const results = this.options.fleet.drainMailbox(agentId, at);
    return results.length === 0 ? {} : { additionalContext: this.#format(results, at) };
  }

  #format(entries: readonly ReportEntry[], deliveredAt: IsoTimestamp): string {
    const omitted = Math.max(0, entries.length - this.#maxResults);
    const selected = entries.slice(omitted);
    const lines = [`At ${deliveredAt}, aboard received ${entries.length} report(s).`];
    if (omitted > 0) lines.push(`${omitted} older report(s) were omitted from this bounded batch.`);
    for (const entry of selected) lines.push(formatReport(entry));
    const joined = lines.join("\n");
    return joined.length <= this.#maxContextChars ? joined : joined.slice(0, this.#maxContextChars);
  }
}

function formatResult(agentId: AgentId, result: WorkerResult): string {
  return result.outcome === "succeeded"
    ? `${agentId} succeeded: ${result.lastAssistantMessage}`
    : `${agentId} failed (${result.failure.type}): ${result.failure.lastAssistantMessage ?? "no final message"}`;
}

function formatReport(entry: ReportEntry): string {
  return entry.kind === "ended-without-report"
    ? `${entry.agentId} (${entry.agentType}) ended without reporting.`
    : formatResult(entry.agentId, entry.result);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export interface InteractiveManagerLauncher {
  spawnInteractive(input: DelegationLaunchInput, recipientAgentId?: AgentId): Promise<unknown>;
  submitReport?(agentId: AgentId, message: string): WorkerResult;
}

export interface InvokingTerminalKiller {
  kill(terminalId: AgentSession["terminal"]["terminalId"]): void;
}

/** The extension-owned actions `/auto`, `/review-pr`, and `/reopen` trigger. */
export interface ManagerCommandActions {
  startAutoRun(options?: { readonly dry?: boolean; readonly additionalGuideline?: string }): Promise<unknown>;
  /** `focus` is the user's trailing text: what they want the session to look at. */
  reviewPullRequest(focus?: string): Promise<unknown>;
  reopenSession(selector?: string): Promise<unknown>;
}

export class ManagerPromptService {
  readonly #now: () => Date;

  public constructor(
    private readonly fleet: FleetRegistry,
    private readonly launcher: InteractiveManagerLauncher,
    now?: () => Date,
    private readonly actions?: ManagerCommandActions,
    private readonly terminals?: InvokingTerminalKiller,
    private readonly reminders?: RoadmapReminderService,
  ) {
    this.#now = now ?? (() => new Date());
  }

  public async handle(agentId: AgentId, prompt: string, roadmapDue = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const done = parseDoneCommand(prompt);
    if (done !== undefined) return this.#done(agentId, done);
    const prototype = parsePrototypeCommand(prompt);
    if (prototype !== undefined) return this.#prototype(agentId, prototype);
    // The route also serves report injection for every aboard session. That
    // must not widen Manager-owned commands merely because a non-Manager has a
    // queued report and therefore pays the prompt-hook round trip.
    const managerCaller = this.fleet.get(agentId)?.identity.type === "manager";
    const action = managerCaller ? parseActionCommand(prompt) : undefined;
    if (action !== undefined) return this.#runAction(agentId, action);
    const command = managerCaller ? parseInteractiveCommand(prompt) : undefined;
    if (command === undefined) {
      const deliveredAt = this.#now().toISOString() as IsoTimestamp;
      const reports = this.fleet.drainMailbox(agentId, deliveredAt);
      const delivery = this.fleet.drainNotifications(agentId, deliveredAt);
      const lines: string[] = [];
      if (reports.length > 0) {
        lines.push(`At ${deliveredAt}, aboard delivered ${reports.length} report(s):`);
        for (const report of reports) lines.push(formatReport(report));
      }
      if (delivery.notifications.length > 0 || delivery.summarized !== undefined) {
        lines.push(`Since your last message (delivered at ${deliveredAt}):`);
        if (delivery.summarized !== undefined) {
          lines.push(
            `${delivery.summarized.count} earlier aboard action(s) occurred between ${delivery.summarized.firstOccurredAt} and ${delivery.summarized.lastOccurredAt}; details were summarized to keep this context bounded.`,
          );
        }
        for (const notification of delivery.notifications) {
          lines.push(`At ${notification.occurredAt}: ${notification.message}`);
        }
      }
      // The reminder shares this drain rather than opening its own channel: one
      // injection carries both, and neither costs the Manager a turn.
      const reminder = roadmapDue && this.reminders !== undefined
        ? (await this.reminders.serve(agentId, signal ?? new AbortController().signal)).additionalContext
        : undefined;
      if (reminder !== undefined) lines.push(reminder);
      return lines.length === 0 ? {} : { additionalContext: lines.join("\n") };
    }

    if (command.invalidArguments) return { intercepted: true, message: "/general-purpose does not accept arguments." };
    const launched = await this.launcher.spawnInteractive(command.input, agentId) as Record<string, unknown>;
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
    if (session.identity.type === "pr-doctor-hitl" && session.autoRunRestricted === true) {
      return {
        intercepted: true,
        message: "This review stays open while its HITL pull request awaits the user's merge. aboard will close the terminal after the pull request lands.",
      };
    }
    try {
      const recipientAgentId = session.resultDelivery.mode === "mailbox" ? session.resultDelivery.recipientAgentId : undefined;
      const report = composeDoneReport(session.lastObservedAssistantMessage, command.furtherNotes);
      let reporting: string;
      if (session.resultDelivery.mode === "tool-result" && report !== undefined && this.launcher.submitReport !== undefined) {
        this.launcher.submitReport(agentId, report);
        reporting = "The report is being returned to the waiting caller.";
      } else if (recipientAgentId === undefined) {
        reporting = "This session has no report recipient.";
      } else if (report === undefined) {
        reporting = `No complete assistant message was available to report to ${recipientAgentId}.`;
      } else {
        this.fleet.submitReport(agentId, report, this.#now().toISOString() as IsoTimestamp);
        const recipient = this.fleet.get(recipientAgentId);
        reporting = recipient === undefined || !active(recipient)
          ? `The report is queued for ${recipientAgentId}, which is not currently open.`
          : `The report is being delivered to ${recipientAgentId}.`;
      }
      this.terminals.kill(session.terminal.terminalId);
      return {
        intercepted: true,
        message: `Closing this terminal. ${reporting}`,
      };
    } catch (error) {
      return { intercepted: true, message: `aboard could not close this terminal: ${error instanceof Error ? error.message : "the terminal action failed"}.` };
    }
  }

  async #prototype(agentId: AgentId, command: ParsedPrototypeCommand): Promise<Record<string, unknown>> {
    const caller = this.fleet.get(agentId);
    if (caller?.identity.type !== "manager" && caller?.identity.type !== "brainstormer") {
      return { intercepted: true, message: "/prototype can be launched only from a Manager or brainstormer terminal." };
    }
    if (command.prompt === undefined) {
      return { intercepted: true, message: "/prototype requires a prompt describing the experiment." };
    }
    const words = command.prompt.split(/\s+/u).map((word) => word.replace(/[^\p{L}\p{N}'-]/gu, "")).filter(Boolean);
    const description = ["prototype", ...words.slice(0, 4)].slice(0, 5).join(" ");
    try {
      const launched = await this.launcher.spawnInteractive({
        type: "prototyper",
        prompt: command.prompt,
        description: description.split(/\s+/u).length < 3 ? `${description} experiment` : description,
      }, agentId) as Record<string, unknown>;
      const launchedAgentId = typeof launched.agentId === "string" ? launched.agentId : "unknown";
      const occurredAt = this.#now().toISOString() as IsoTimestamp;
      const followUp = caller.identity.type === "brainstormer"
        ? " Once you have it, you can use the continue_agent tool to ask follow up questions concerning the proposed prototype."
        : "";
      this.fleet.enqueueNotification(
        agentId,
        `The user manually launched a prototype agent with agent ID: ${launchedAgentId}. It may or may not experiment on this session's recent activities. You will be notified when the agent submits a report.${followUp}`,
        occurredAt,
      );
      return { intercepted: true, message: `Prototype launched and focused (agent ${launchedAgentId}).` };
    } catch (error) {
      return { intercepted: true, message: `aboard could not launch the prototype: ${error instanceof Error ? error.message : "the launch failed"}.` };
    }
  }

  async #runAction(agentId: AgentId, action: ParsedActionCommand): Promise<Record<string, unknown>> {
    if (this.actions === undefined) {
      return { intercepted: true, message: `aboard cannot handle /${action.command} right now: the extension action is unavailable.` };
    }
    if (action.invalidArguments) {
      return {
        intercepted: true,
        message: action.type === "auto"
          ? "/auto accepts the optional --dry flag before an optional session guideline."
          : `/${action.command} does not accept those arguments.`,
      };
    }
    let outcome: unknown;
    try {
      outcome = action.type === "auto"
        ? await this.actions.startAutoRun({
            ...(action.dry ? { dry: true as const } : {}),
            ...(action.additionalGuideline === undefined ? {} : { additionalGuideline: action.additionalGuideline }),
          })
        : action.type === "reopen"
          ? await this.actions.reopenSession(action.selector)
          : await this.actions.reviewPullRequest(action.focus);
    } catch (error) {
      return { intercepted: true, message: `aboard could not run /${action.command}: ${error instanceof Error ? error.message : "the action failed"}.` };
    }
    const summary = describeActionOutcome(action.type, outcome);
    const message = action.type === "auto"
      && action.additionalGuideline !== undefined
      && record(outcome)?.dryRun !== true
      && record(outcome)?.started === true
      ? `${summary} The additional session guideline will be appended to every implementer and pr-doctor prompt.`
      : summary;
    const isDryRun = action.type === "auto" && record(outcome)?.dryRun === true;
    if (!isDryRun) {
      const occurredAt = this.#now().toISOString() as IsoTimestamp;
      this.fleet.enqueueNotification(agentId, `you ran /${action.command}: ${message}`, occurredAt);
    }
    return {
      intercepted: true,
      message,
    };
  }
}

function describeActionOutcome(type: ParsedActionCommand["type"], outcome: unknown): string {
  if (typeof outcome !== "object" || outcome === null) {
    return type === "auto" ? "auto-run triggered." : type === "reopen" ? "reopened a recorded session." : "reopened the session for the open pull request.";
  }
  const value = outcome as Record<string, unknown>;
  // `/reopen` returns the coordinator's own union, which already has one
  // wording shared with the palette command; describing it twice would drift.
  if (type === "reopen") return describeReopenOutcome(outcome as ReopenOutcome);
  if (type === "auto") {
    if (value.dryRun === true) return describeAutoRunDryRun(outcome as AutoRunDryRunResult);
    if (value.started === false) return `auto-run did not start: ${typeof value.reason === "string" ? value.reason : "no reason given"}.`;
    const issues = Array.isArray(value.issues) ? value.issues.length : 0;
    const cycles = Array.isArray(value.dependencyCycles) ? value.dependencyCycles.length : 0;
    return `auto-run started with ${issues} issue${issues === 1 ? "" : "s"} queued${cycles === 0 ? "" : `; ${cycles} dependency cycle${cycles === 1 ? "" : "s"} detected and safely relaxed`}.`;
  }
  switch (value.action) {
    case "none": return "No pull request is open, so nothing was launched.";
    case "focused": return `Focused the ${String(value.type)} terminal for PR #${String(value.prNumber)}.${unusedFocusNote(value.unusedFocus)}`;
    case "resumed": return `Resumed the ${String(value.type)} session for PR #${String(value.prNumber)}.${unusedFocusNote(value.unusedFocus)}`;
    case "launched": return String(value.notice ?? `Launched a reviewer for PR #${String(value.prNumber)}.`);
    default: return "Reopened the session for the open pull request.";
  }
}

function describeAutoRunDryRun(result: AutoRunDryRunResult): string {
  if (!result.inspected) {
    return `Auto-run dry run could not inspect the next run: ${result.reason}. No changes were made.`;
  }

  const lines = [
    "Auto-run dry run - no branches, worktrees, terminals, commits, pull requests, issues, or runtime state were changed.",
    result.ready ? "Ready: /auto can start with the repository state inspected." : `Blocked: ${result.blockers.join("; ")}.`,
    "",
    "Run plan:",
    `- Session: create ${result.sessionBranch} from ${result.sessionBase}; every issue PR targets that session branch.`,
    result.isolatedWorkspace
      ? `- Workspace: create a separate checkout; your checkout and branch stay untouched${result.keepsWorkspace ? ", and the checkout is kept when the run drains" : ", and the checkout is removed after a clean drain"}.`
      : "- Workspace: use this checkout; it must be clean, aboard moves HEAD during the run, restores the current branch after success, cancellation, or interruption, and keeps the active run branch on failure so you can fix it there.",
    `- Agents: visible implementers run one at a time; [AI]-chrome issues enable Claude in Chrome; pull-request review is ${result.reviewMode ? "on" : "off"}.`,
    ...(result.additionalGuideline === undefined
      ? []
      : ["- Additional guideline: append this final section to every implementer and pr-doctor prompt:", "", "# Additional User Guideline For this Session", "", result.additionalGuideline]),
    "",
    `Forecast issue order (${result.issues.length}):`,
  ];

  if (result.issues.length === 0) lines.push("- None.");
  for (const [index, issue] of result.issues.entries()) {
    const difficulty = issue.difficulty === undefined ? "unrated (most capable tier)" : `${issue.difficulty} difficulty`;
    const review = result.reviewMode
      ? issue.disposition === "hitl"
        ? " An interactive pr-doctor reports findings and applies only fixes you approve."
        : " An automated pr-doctor reviews and may leave fixes for aboard to commit."
      : "";
    const gate = issue.disposition === "hitl"
      ? ` You must merge its PR, or another account must approve it so aboard may merge it, before the issue is closed and the run continues${result.pauseAfterHitl ? "; after it lands, the run pauses and you must run /auto again" : ""}.`
      : " Aboard merges its PR into the session branch and closes the issue; you act only if a conflict cannot be reconciled or the repository refuses the merge.";
    lines.push(
      `${index + 1}. #${issue.number} ${issue.title} ([AI]-${issue.disposition}, ${difficulty}${issue.chrome ? ", [AI]-chrome" : ""}) -> ${issue.branch}. A visible implementer leaves edits; aboard comments on the issue, commits, pushes, and opens the PR.${review}${gate}`,
    );
  }

  if (result.dependencyCycles.length > 0) {
    lines.push("", "Dependency cycles:");
    for (const cycle of result.dependencyCycles) lines.push(`- ${cycle.map((number) => `#${number}`).join(", ")}: internal edges are relaxed and those issues are ordered oldest first.`);
  }
  if (result.skipped.length > 0) {
    // Unclassified issues are the ordinary state of most projects and can number
    // in the dozens, so they are counted, not listed; the actionable "blocked
    // by" entries keep their per-issue reasons.
    const unclassified = result.skipped.filter((issue) => issue.reason.startsWith("unclassified:"));
    const other = result.skipped.filter((issue) => !issue.reason.startsWith("unclassified:"));
    const parts: string[] = [];
    if (unclassified.length > 0) parts.push(`${unclassified.length} unclassified (neither [AI]-afk nor [AI]-hitl)`);
    for (const issue of other) parts.push(`#${issue.number}: ${issue.reason}`);
    lines.push("", `Skipped for this forecast: ${parts.join("; ")}.`);
  }

  lines.push(
    "",
    result.mergesItsOwnPullRequest
      ? `After the queue: aboard opens one PR from ${result.sessionBranch} into ${result.sessionBase} and attempts to merge it; you act if reconciliation or the merge fails.`
      : `After the queue: aboard opens one PR from ${result.sessionBranch} into ${result.sessionBase}; you must review and merge that final PR.`,
    "The order is a forecast: aboard re-reads GitHub after every issue, so newly unblocked, closed, or relabelled work can change what comes next.",
  );
  return lines.join("\n");
}

function unusedFocusNote(focus: unknown): string {
  return typeof focus === "string" && focus.length > 0
    ? " The focus you typed was not applied — that session is already loaded; type it in the terminal."
    : "";
}

interface ParsedActionCommand {
  readonly type: "auto" | "review-pr" | "reopen";
  readonly command: string;
  readonly invalidArguments: boolean;
  readonly dry: boolean;
  /** `/auto` only: user-authored text appended to every auto agent prompt. */
  readonly additionalGuideline?: string;
  /** `/review-pr` only: the trailing text, forwarded as the review focus. */
  readonly focus?: string;
  /** `/reopen` only: the trailing text, an agent id or an agent type. */
  readonly selector?: string;
}

interface ParsedDoneCommand {
  readonly furtherNotes?: string;
}

interface ParsedPrototypeCommand {
  readonly prompt?: string;
}

function parseDoneCommand(prompt: string): ParsedDoneCommand | undefined {
  const match = /^\s*\/done(?:\s+([\s\S]*?))?\s*$/.exec(prompt);
  if (match === null) return undefined;
  const furtherNotes = match[1]?.trim();
  return furtherNotes === undefined || furtherNotes.length === 0 ? {} : { furtherNotes };
}

function composeDoneReport(lastAssistantMessage: string | undefined, furtherNotes: string | undefined): string | undefined {
  if (lastAssistantMessage === undefined) return undefined;
  return furtherNotes === undefined
    ? lastAssistantMessage
    : `${lastAssistantMessage}\n\nFurther notes:\n${furtherNotes}`;
}

function parsePrototypeCommand(prompt: string): ParsedPrototypeCommand | undefined {
  const match = /^\s*\/prototype(?:\s+([\s\S]*?))?\s*$/u.exec(prompt);
  if (match === null) return undefined;
  const instruction = match[1]?.trim();
  return instruction === undefined || instruction.length === 0 ? {} : { prompt: instruction };
}

function parseActionCommand(prompt: string): ParsedActionCommand | undefined {
  const match = /^\s*\/(auto|review-pr|reopen)(?:\s+([\s\S]*?))?\s*$/.exec(prompt);
  if (match === null) return undefined;
  const command = match[1] as "auto" | "review-pr" | "reopen";
  const trailing = match[2]?.trim() ?? "";
  if (command === "review-pr") {
    return { type: command, command, invalidArguments: false, dry: false, ...(trailing.length === 0 ? {} : { focus: trailing }) };
  }
  if (command === "reopen") {
    return { type: command, command, invalidArguments: false, dry: false, ...(trailing.length === 0 ? {} : { selector: trailing }) };
  }
  const flags: string[] = [];
  let remainder = trailing;
  while (remainder.startsWith("--")) {
    const token = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(remainder);
    if (token === null) break;
    const flag = token[1]!;
    if (flag !== "--dry") {
      return { type: command, command, invalidArguments: true, dry: false };
    }
    flags.push(flag);
    remainder = token[2]?.trim() ?? "";
  }
  return {
    type: command,
    command,
    invalidArguments: new Set(flags).size !== flags.length,
    dry: flags.includes("--dry"),
    ...(remainder.length === 0 ? {} : { additionalGuideline: remainder }),
  };
}

function parseInteractiveCommand(prompt: string): {
  readonly type: "brainstormer" | "general-purpose";
  readonly command: string;
  readonly invalidArguments: boolean;
  readonly ignoredArguments: boolean;
  readonly input: DelegationLaunchInput;
} | undefined {
  const match = /^\s*\/(brainstorm|general-purpose)(?:\s+([\s\S]*?))?\s*$/.exec(prompt);
  if (match === null) return undefined;
  const command = match[1] as "brainstorm" | "general-purpose";
  const trailing = match[2]?.trim() ?? "";
  return command === "general-purpose"
    ? {
        type: "general-purpose",
        command,
        invalidArguments: false,
        ignoredArguments: trailing.length > 0,
        input: { type: "general-purpose", description: "general purpose interactive session" },
      }
    : { type: "brainstormer", command, invalidArguments: false, ignoredArguments: trailing.length > 0, input: { type: "brainstormer", description: "interactive brainstorm session" } };
}

export type ManagerTranscriptCheckpoint = (agentId: AgentId) => void;

export function createManagerHookRoutes(
  briefings: ManagerBriefings,
  stop: ManagerStopService,
  prompts?: ManagerPromptService,
  reminders?: RoadmapReminderService,
  checkpoint?: ManagerTranscriptCheckpoint,
): BridgeRequestHandler {
  return async (request): Promise<BridgeResponse> => {
    if (request.method !== "POST") return protocolError(405, "invalid-request", "Method not allowed");
    if (request.url.pathname === "/hooks/manager/brief") {
      return { status: 200, body: { additionalContext: await briefings.render(request.signal) } };
    }
    if (request.url.pathname === "/hooks/reports/stop") {
      const body = record(request.body);
      if (body === undefined || typeof body.agentId !== "string" || body.agentId.trim() === "" || typeof (body.stopHookActive ?? body.stop_hook_active) !== "boolean") {
        return protocolError(400, "invalid-request", "agentId and stopHookActive are required");
      }
      checkpoint?.(body.agentId as AgentId);
      const lastAssistantMessage = typeof (body.lastAssistantMessage ?? body.last_assistant_message) === "string"
        ? (body.lastAssistantMessage ?? body.last_assistant_message) as string
        : undefined;
      return { status: 200, body: await stop.poll({ agentId: body.agentId as AgentId, stopHookActive: (body.stopHookActive ?? body.stop_hook_active) as boolean, ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage }) }, request.signal) };
    }
    if (request.url.pathname === "/hooks/reports/deliver") {
      const body = record(request.body);
      if (body === undefined || typeof body.agentId !== "string" || body.agentId.trim() === "") {
        return protocolError(400, "invalid-request", "agentId is required");
      }
      return { status: 200, body: stop.deliver(body.agentId as AgentId) };
    }
    if (request.url.pathname === "/hooks/manager/roadmap" && reminders !== undefined) {
      const body = record(request.body);
      if (body === undefined || typeof body.agentId !== "string" || body.agentId.trim() === "") {
        return protocolError(400, "invalid-request", "agentId is required");
      }
      return { status: 200, body: await reminders.serve(body.agentId as AgentId, request.signal) };
    }
    if (request.url.pathname === "/hooks/manager/prompt" && prompts !== undefined) {
      const body = record(request.body);
      if (body === undefined || typeof body.agentId !== "string" || body.agentId.trim() === "" || typeof body.prompt !== "string") {
        return protocolError(400, "invalid-request", "agentId and prompt are required");
      }
      try {
        return { status: 200, body: await prompts.handle(body.agentId as AgentId, body.prompt, body.roadmapDue === true, request.signal) };
      } catch (error) {
        return protocolError(error instanceof Error && "code" in error && error.code === "lease-conflict" ? 409 : 500, error instanceof Error && "code" in error && error.code === "lease-conflict" ? "conflict" : "internal-error", error instanceof Error ? error.message : "Interactive launch failed");
      }
    }
    return protocolError(404, "not-found", "Route not found");
  };
}
