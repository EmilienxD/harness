import type { EffortLevel, LaunchConfiguration } from "../claude/launch.js";
import { planLaunch, planSessionResume } from "../claude/launch.js";
import type { ResolvedPrompt } from "../claude/prompts.js";
import { dirname } from "node:path";
import type { PromptSpillStore } from "../claude/spill.js";
import type { ShellKind } from "../claude/shell.js";
import type { TerminalController } from "../claude/terminals.js";
import type { WriteCapability } from "../domain/capability.js";
import {
  isContinuableAgentType,
  isInteractiveAgentType,
  isNonRestorablePersistedAgentType,
  type AgentId,
  type AgentSession,
  type AgentTelemetry,
  type AgentType,
  type IsoTimestamp,
  type SessionId,
  type WorkerResult,
} from "../domain/contracts.js";
import { FleetRegistry } from "../domain/fleet.js";
import {
  WriteLease,
  leaseRequired,
  type LaunchOrigin,
  type LeaseHolderObservation,
  type SessionObservation,
  type WriteLeaseHolder,
} from "../domain/lease.js";
import type { SessionWrapperLayout } from "../claude/launch.js";
import { sessionIsResumable } from "../claude/sessions.js";
import { AUTO_RUN_DISALLOWED_TOOLS } from "../auto/permissions.js";
import type { IssueDifficulty } from "../shared/labels.js";

export interface LaunchIsolation {
  readonly cwd: string;
  /** Permission deny rules added to this launch's `--disallowedTools`. */
  readonly denyTools: readonly string[];
}

export interface DelegationLaunchInput {
  readonly type: Exclude<AgentType, "manager">;
  readonly prompt?: string;
  /** Persistent configured note, ordered before the per-run guideline. */
  readonly permanentPrompt?: string;
  readonly additionalGuideline?: string;
  readonly description: string;
  /** Every issue whose resolved contract belongs in the opening prompt, in the caller's order. */
  readonly issues?: readonly number[];
  /** Whether resolved issue context follows references found in directly related issues. */
  readonly recursiveIssueReferences?: boolean;
  readonly pullRequest?: number;
  readonly focus?: string;
  /** Set only by auto-run when the implementer's frozen issue has `[AI]-chrome`. */
  readonly chrome?: true;
  readonly expectsUncommittedTree?: boolean;
  /** Set only by the auto-run engine, and only when the run has its own checkout. */
  readonly isolation?: LaunchIsolation;
  readonly difficulty?: IssueDifficulty;
}

/** What the engine needs back from a launch: the handles plus the result. */
export interface AutomatedLaunchOutcome {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: AgentSession["terminal"]["terminalId"];
  readonly result: WorkerResult;
}

export interface ReopenTarget {
  readonly agentId: AgentId;
  readonly type: Exclude<AgentType, "manager">;
  readonly sessionId: SessionId;
  /** Preserved only for a restored mailbox obligation; foreground callers do not survive a handoff. */
  readonly resultDelivery?: AgentSession["resultDelivery"];
  /** The terminal name, already carrying aboard's own prefix. */
  readonly terminalName: string;
  readonly issueNumbers?: readonly number[];
  readonly difficulty?: IssueDifficulty;
  readonly chromeEnabled?: true;
  /** Default is the controller's; a bulk restore passes `false` explicitly. */
  readonly focus?: boolean;
  /** Replays the command fence carried by a session that originated in auto-run. */
  readonly autoRunRestricted?: true;
  readonly cwd?: string;
  /** A continuation's first message; ordinary reopen leaves the conversation idle. */
  readonly prompt?: string;
  /** Ordinary reopen is attended; continuation derives this from the target role. */
  readonly attended?: boolean;
  /** Reacquires the auto-run write lease before restoring an unattended worker. */
  readonly origin?: LaunchOrigin;
}

export interface InteractiveLaunchHandles {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: AgentSession["terminal"]["terminalId"];
}

export interface DelegationConfigurationSource {
  get(type: Exclude<AgentType, "manager">): Promise<LaunchConfiguration>;
}

export interface DelegationPromptResolver {
  resolve(input: DelegationLaunchInput, options: { readonly interactive: boolean }): Promise<ResolvedPrompt | undefined>;
}

export interface DelegationCoordinatorOptions {
  /** Runtime admission gate; closed synchronously before reset cleanup begins. */
  readonly admission?: () => boolean;
  readonly workspaceRoot: string;
  /** Absolute mutable-state root supplied by the extension host. */
  readonly runtimeDirectory?: string;
  /** Tests transcript availability before deciding between resume and a fresh session. */
  readonly isResumable?: (sessionId: SessionId, cwd: string) => Promise<boolean>;
  readonly fleet: FleetRegistry;
  readonly lease: WriteLease;
  readonly terminals: TerminalController;
  readonly sessions?: { observe(agentId: AgentId): SessionObservation };
  readonly onStaleLeaseRecovered?: (holder: WriteLeaseHolder, observation: LeaseHolderObservation) => void;
  readonly configurations: DelegationConfigurationSource;
  readonly prompts: DelegationPromptResolver;
  readonly spills: PromptSpillStore;
  /** Resolved lazily so extension activation alone does not consume the first agent id. */
  readonly managerAgentId: () => AgentId;
  /** Writes a resolved per-launch MCP registration for roles that own a catalog. */
  readonly mcpConfig?: (agentId: AgentId, type: AgentType) => Promise<string | undefined>;
  readonly shell: ShellKind;
  /** Infrastructure-level denials applied to every delegated launch and resume. */
  readonly disallowedTools?: readonly string[];
  readonly command?: () => readonly string[] | undefined;
  /** Verifies the Claude command runs at all; throws to refuse the launch. */
  readonly preflight?: (command: readonly string[] | undefined) => Promise<void>;
  readonly effort?: () => EffortLevel | undefined;
  readonly agentIdFactory: () => AgentId;
  readonly sessionIdFactory: () => SessionId;
  readonly now?: () => Date;
  readonly maxInlinePromptChars?: number;
  readonly startupTimeoutMs?: number;
  readonly wrapper?: SessionWrapperLayout;
}

export class DelegationError extends Error {
  public constructor(
    public readonly code: "lease-conflict" | "unknown-agent" | "agent-active" | "aborted" | "unresumable-session",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

function leaseReason(origin: LaunchOrigin): string {
  return origin === "auto-run" ? "auto-run launched agent" : "manager launched an automated agent";
}

const EMPTY_TELEMETRY: AgentTelemetry = {
  totalTokens: 0,
  totalDurationMs: 0,
  totalToolUseCount: 0,
  compactionCount: 0,
};

export class DelegationCoordinator {
  readonly #waiters = new Map<AgentId, (result: WorkerResult) => void>();
  readonly #foregroundReturnTargets = new Map<AgentId, AgentId>();
  readonly #now: () => Date;

  public constructor(private readonly options: DelegationCoordinatorOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  public async run(input: DelegationLaunchInput, signal?: AbortSignal): Promise<unknown> {
    const launched = await this.#launch(input, { mode: "tool-result" }, "manager", false);
    const result = await this.#waitForResult(launched.agentId, signal);
    return this.#foregroundResult(launched.agentId, result);
  }

  public async runInteractive(input: DelegationLaunchInput, signal?: AbortSignal, returnTargetAgentId?: AgentId): Promise<unknown> {
    const launched = await this.#launch(input, { mode: "tool-result" }, "manager", true, undefined, returnTargetAgentId);
    const result = await this.#waitForResult(launched.agentId, signal);
    return this.#foregroundResult(launched.agentId, result);
  }

  public async runAutomated(input: DelegationLaunchInput, signal?: AbortSignal): Promise<AutomatedLaunchOutcome> {
    const launched = await this.#launch(input, { mode: "tool-result" }, "auto-run", false);
    const stopWorker = (): void => {
      try { this.options.terminals.kill(launched.terminalId); } catch { /* terminal already settled */ }
    };
    if (signal?.aborted) stopWorker();
    else signal?.addEventListener("abort", stopWorker, { once: true });
    try {
      // Auto-run owns this terminal. Cancelling it stops the worker, but the
      // result wait remains attached until terminal lifecycle has classified
      // the kill and released the lease.
      const result = await this.#waitForResult(launched.agentId);
      return { ...launched, result };
    } finally {
      signal?.removeEventListener("abort", stopWorker);
    }
  }

  public async launchInteractive(input: DelegationLaunchInput, origin: LaunchOrigin): Promise<InteractiveLaunchHandles> {
    return this.#launch(input, { mode: "none" }, origin, true);
  }

  /** Starts a prompted, unattended session without making the Manager wait for a report. */
  public async launchQueued(input: DelegationLaunchInput, beforeTerminal?: () => Promise<void>): Promise<InteractiveLaunchHandles> {
    return this.#launch(input, { mode: "none" }, "manager", false, beforeTerminal);
  }

  /** Reopens a persisted active worker after the extension host restarted. */
  public async resumePersisted(session: AgentSession): Promise<InteractiveLaunchHandles> {
    if (session.identity.type === "manager") {
      throw new DelegationError("unknown-agent", "The Manager has its own lifecycle");
    }
    // Automated-only research types have no user conversation to hand off, so a
    // restore whose result caller is gone leaves nobody to talk to.
    if (isNonRestorablePersistedAgentType(session.identity.type)) {
      throw new DelegationError(
        "unresumable-session",
        `The ${session.identity.type} session cannot be restored after its result caller is gone; launch a fresh ${session.identity.type} instead`,
      );
    }
    return this.reopen({
      agentId: session.identity.agentId,
      type: session.identity.type,
      sessionId: session.sessionId,
      ...(session.resultDelivery.mode === "mailbox" ? { resultDelivery: session.resultDelivery } : {}),
      terminalName: session.terminal.name,
      ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
      ...(session.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
      // Restoration opens several terminals at once, so none of them steals
      // focus; the caller shows the one the user should land in.
      focus: false,
    });
  }

  public async reopen(target: ReopenTarget): Promise<InteractiveLaunchHandles> {
    const configuration = await this.options.configurations.get(target.type);
    // Where the session ran is where its conversation is: a session that ran in
    // an auto-run's own checkout has no transcript under the workspace at all.
    const cwd = target.cwd ?? this.options.workspaceRoot;
    const resumable = await (this.options.isResumable ?? sessionIsResumable)(target.sessionId, cwd);
    if (!resumable) {
      throw new DelegationError("unresumable-session", `Session ${target.sessionId} has no Claude conversation to resume`);
    }
    const attended = target.attended ?? true;
    const mcpConfigPath = await this.options.mcpConfig?.(target.agentId, target.type);
    const plan = planSessionResume({
      agentId: target.agentId,
      sessionId: target.sessionId,
      agentType: target.type,
      shell: this.options.shell,
      attended,
      ...(target.type === "implementer" && target.chromeEnabled === true ? { chrome: true } : {}),
      configuration,
      runtimeDirectory: this.options.runtimeDirectory ?? (this.options.wrapper === undefined ? undefined : dirname(dirname(this.options.wrapper.lockPathFor(target.agentId)))),
      ...(target.prompt === undefined ? {} : { prompt: target.prompt }),
      ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
      maxInlinePromptChars: this.options.maxInlinePromptChars,
      disallowedTools: [
        ...this.#infrastructureDenials(mcpConfigPath),
        ...(target.autoRunRestricted === true ? AUTO_RUN_DISALLOWED_TOOLS : []),
      ],
      ...this.#effort(),
      ...this.#command(),
      ...(target.difficulty === undefined ? {} : { difficulty: target.difficulty }),
      ...(this.options.wrapper === undefined ? {} : { wrapper: this.options.wrapper }),
    });
    await this.options.preflight?.(plan.command);
    const occurredAt = this.#timestamp();
    const origin = target.origin;
    if (origin !== undefined && leaseRequired(origin, attended)) {
      this.#acquire(plan.writeCapability, target.agentId, target.sessionId, occurredAt, leaseReason(origin));
    }
    let terminalStarted = false;
    let startedTerminalId: AgentSession["terminal"]["terminalId"] | undefined;
    try {
      await this.options.spills.prepare(plan, target.cwd);
      if (plan.spill !== undefined) await this.options.spills.write(plan.spill, target.cwd);
      if (this.options.admission?.() === false) throw new Error("aboard runtime is not initialized");
      const existing = this.options.fleet.get(target.agentId);
      if (existing !== undefined && (
        existing.identity.type !== target.type
        || existing.sessionId !== target.sessionId
      )) {
        throw new DelegationError(
          "unknown-agent",
          `Agent ${target.agentId} is registered to a different ${existing.identity.type} session`,
        );
      }
      const resultDelivery = target.resultDelivery ?? { mode: "none" } as const;
      const terminal = this.options.terminals.create({
        agentId: target.agentId,
        sessionId: target.sessionId,
        agentType: target.type,
        ...(target.issueNumbers === undefined ? {} : { issueNumbers: target.issueNumbers }),
        name: target.terminalName,
        ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
        initialCommand: plan.commandLine,
        attended,
        ...(target.focus === undefined ? {} : { focus: target.focus }),
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      });
      terminalStarted = true;
      startedTerminalId = terminal.terminalId;
      const fleetTerminal = { terminalId: terminal.terminalId, name: terminal.name };
      if (existing === undefined) {
        this.options.fleet.register({
          identity: { agentId: target.agentId, type: target.type },
          sessionId: target.sessionId,
          terminal: fleetTerminal,
          lifecycle: { status: "starting", startedAt: occurredAt },
          resultDelivery,
          ...(attended ? { attended: true as const } : {}),
          telemetry: EMPTY_TELEMETRY,
          ...(target.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
          ...(target.issueNumbers === undefined ? {} : { issueNumbers: target.issueNumbers }),
          ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
          ...(target.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
        }, occurredAt);
      } else if (existing.lifecycle.status === "completed" || existing.lifecycle.status === "failed") {
        this.options.fleet.restart(
          target.agentId,
          fleetTerminal,
          occurredAt,
          target.sessionId,
          attended,
          resultDelivery,
        );
      } else {
        this.options.fleet.reattach(
          target.agentId,
          fleetTerminal,
          occurredAt,
          target.sessionId,
          resultDelivery,
          attended,
        );
      }
      this.options.fleet.transition(target.agentId, { status: "running", startedAt: occurredAt }, occurredAt);
      return { agentId: target.agentId, sessionId: target.sessionId, terminalId: terminal.terminalId };
    } catch (error) {
      this.options.lease.release(target.agentId, occurredAt, "resume failed");
      if (startedTerminalId !== undefined) {
        try { this.options.terminals.kill(startedTerminalId); } catch { /* already closed */ }
      }
      if (!terminalStarted) await this.options.spills.remove?.(target.agentId).catch(() => undefined);
      throw error;
    }
  }

  /** Restores one ended auto-run worker and waits for its next report. */
  public async resumeAutomated(
    session: AgentSession,
    prompt: string,
    difficulty?: IssueDifficulty,
    signal?: AbortSignal,
  ): Promise<AutomatedLaunchOutcome> {
    if (session.autoRunRestricted !== true || !["completed", "failed"].includes(session.lifecycle.status)) {
      throw new DelegationError("unresumable-session", `Agent ${session.identity.agentId} is not an ended auto-run session`);
    }
    // The first automated wait receives the result directly from `complete`;
    // discard its retained blocking copy before waiting for the continuation.
    this.options.fleet.takeBlockingResult(session.identity.agentId, this.#timestamp());
    const launched = await this.reopen({
      agentId: session.identity.agentId,
      type: session.identity.type as Exclude<AgentType, "manager">,
      sessionId: session.sessionId,
      terminalName: session.terminal.name,
      ...(session.issueNumbers === undefined ? {} : { issueNumbers: session.issueNumbers }),
      ...(difficulty === undefined ? {} : { difficulty }),
      ...(session.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      autoRunRestricted: true,
      prompt,
      attended: false,
      resultDelivery: { mode: "tool-result" },
      origin: "auto-run",
    });
    const stopWorker = (): void => {
      try { this.options.terminals.kill(launched.terminalId); } catch { /* terminal already settled */ }
    };
    if (signal?.aborted) stopWorker();
    else signal?.addEventListener("abort", stopWorker, { once: true });
    try {
      const result = await this.#waitForResult(launched.agentId);
      return { ...launched, result };
    } finally {
      signal?.removeEventListener("abort", stopWorker);
    }
  }

  public async spawn(input: DelegationLaunchInput, recipientAgentId = this.options.managerAgentId()): Promise<unknown> {
    const launched = await this.#launch(input, {
      mode: "mailbox",
      recipientAgentId,
    }, "manager", false);
    return { ...launched, status: "running" };
  }

  /** Reopens one reported research/prototype conversation under the same agent id. */
  public async continue(target: ReopenTarget, prompt: string, recipientAgentId: AgentId): Promise<unknown> {
    if (!isContinuableAgentType(target.type)) {
      throw new DelegationError("unknown-agent", `${target.type} sessions cannot be continued`);
    }
    const current = this.options.fleet.get(target.agentId);
    if (current !== undefined && ["starting", "running", "awaiting-user"].includes(current.lifecycle.status)) {
      throw new DelegationError("agent-active", `Agent ${target.agentId} is still live; its report is coming`);
    }
    // Completion can enqueue the report before SessionEnd/process settlement
    // detaches the spent terminal. Do not remove the fleet row and then fail
    // terminal creation: the old and new wrappers would also contend for the
    // same per-agent liveness marker. A retry after settlement reopens safely.
    const spentTerminal = this.options.terminals.liveTerminalForAgent(target.agentId);
    if (spentTerminal !== undefined) {
      throw new DelegationError("agent-active", `Agent ${target.agentId} has reported and its terminal is still closing; retry the follow-up once it closes`);
    }
    if (current !== undefined) this.options.fleet.remove(target.agentId, this.#timestamp());
    const handles = await this.reopen({
      ...target,
      prompt,
      attended: isInteractiveAgentType(target.type),
      resultDelivery: { mode: "mailbox", recipientAgentId },
    });
    return { ...handles, status: "running", reportRecipientAgentId: recipientAgentId };
  }

  public async spawnInteractive(input: DelegationLaunchInput, recipientAgentId = this.options.managerAgentId()): Promise<unknown> {
    const launched = await this.#launch(input, { mode: "mailbox", recipientAgentId }, "manager", true);
    return {
      ...launched,
      handoff: `Terminal focused for ${input.description}. Its report will be delivered to ${recipientAgentId} when the user runs /done.`,
    };
  }

  /** Called by the worker result boundary after lifecycle classification. */
  public complete(agentId: AgentId, result: WorkerResult): boolean {
    const session = this.#requireAgent(agentId);
    if (session.lifecycle.status === "completed" || session.lifecycle.status === "failed") return false;
    const finishedAt = this.#timestamp();
    if (result.outcome === "succeeded") {
      this.options.fleet.transition(agentId, {
        status: "completed",
        startedAt: session.lifecycle.startedAt,
        finishedAt,
        exitCode: result.exitCode,
        lastAssistantMessage: result.lastAssistantMessage,
      }, finishedAt);
    } else {
      this.options.fleet.transition(agentId, {
        status: "failed",
        startedAt: session.lifecycle.startedAt,
        finishedAt,
        failure: result.failure,
      }, finishedAt);
    }
    this.options.fleet.recordResult(agentId, result, finishedAt);
    this.options.lease.releaseForTerminalOutcome(agentId, finishedAt, "agent finished");
    this.#waiters.get(agentId)?.(result);
    this.#waiters.delete(agentId);
    this.#foregroundReturnTargets.delete(agentId);
    return true;
  }

  /** Completes an attended foreground launch from its explicit `/done` report. */
  public submitReport(agentId: AgentId, message: string): WorkerResult {
    const occurredAt = this.#timestamp();
    const result = this.options.fleet.submitReport(agentId, message, occurredAt);
    this.options.lease.releaseForTerminalOutcome(agentId, occurredAt, "agent reported done");
    this.#waiters.get(agentId)?.(result);
    this.#waiters.delete(agentId);
    const returnTarget = this.#foregroundReturnTargets.get(agentId);
    this.#foregroundReturnTargets.delete(agentId);
    if (returnTarget !== undefined) {
      const caller = this.options.fleet.get(returnTarget);
      if (caller !== undefined && ["starting", "running", "awaiting-user"].includes(caller.lifecycle.status)) {
        try { this.options.terminals.show(caller.terminal.terminalId); } catch { /* caller terminal closed */ }
      }
    }
    return result;
  }

  async #launch(input: DelegationLaunchInput, resultDelivery: AgentSession["resultDelivery"], origin: LaunchOrigin, attended: boolean, beforeTerminal?: () => Promise<void>, returnTargetAgentId?: AgentId): Promise<{
    readonly agentId: AgentId;
    readonly sessionId: SessionId;
    readonly terminalId: AgentSession["terminal"]["terminalId"];
  }> {
    const agentId = this.options.agentIdFactory();
    const sessionId = this.options.sessionIdFactory();
    const mcpConfigPath = await this.options.mcpConfig?.(agentId, input.type);
    const [configuration, prompt] = await Promise.all([
      this.options.configurations.get(input.type),
      this.options.prompts.resolve(input, { interactive: attended }),
    ]);
    const plan = planLaunch({
      agentId,
      sessionId,
      agentType: input.type,
      shell: this.options.shell,
      attended,
      ...(input.type === "implementer" && input.chrome === true ? { chrome: true } : {}),
      configuration,
      runtimeDirectory: this.options.runtimeDirectory ?? (this.options.wrapper === undefined ? undefined : dirname(dirname(this.options.wrapper.lockPathFor(agentId)))),
      ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
      prompt,
      disallowedTools: [
        ...this.#infrastructureDenials(mcpConfigPath),
        ...(origin === "auto-run" ? AUTO_RUN_DISALLOWED_TOOLS : []),
        ...(input.isolation?.denyTools ?? []),
      ],
      ...this.#command(),
      ...this.#effort(),
      ...(input.difficulty === undefined ? {} : { difficulty: input.difficulty }),
      maxInlinePromptChars: this.options.maxInlinePromptChars,
      ...(this.options.wrapper === undefined ? {} : { wrapper: this.options.wrapper }),
    });
    await this.options.preflight?.(plan.command);
    const occurredAt = this.#timestamp();
    if (input.type !== "prototyper" && leaseRequired(origin, attended)) {
      this.#acquire(plan.writeCapability, agentId, sessionId, occurredAt, leaseReason(origin));
    }
    const cwd = input.isolation?.cwd;
    let terminalStarted = false;
    try {
      await this.options.spills.prepare(plan, cwd);
      if (plan.spill !== undefined) await this.options.spills.write(plan.spill, cwd);
      // Queue admission is rechecked after potentially slow launch preparation,
      // while holding the write lease, immediately before opening the terminal.
      await beforeTerminal?.();
      if (this.options.admission?.() === false) throw new Error("aboard runtime is not initialized");
      const terminal = this.options.terminals.create({
        agentId,
        sessionId,
        agentType: input.type,
        ...(input.issues === undefined ? {} : { issueNumbers: input.issues }),
        name: `aboard: ${input.description}`,
        ...(cwd === undefined ? {} : { cwd }),
        initialCommand: plan.commandLine,
        attended,
        // A failed launch prints to the terminal and exits before any hook; the
        // SessionStart pid report is the only trustworthy proof the TUI is up.
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      });
      terminalStarted = true;
      this.options.fleet.register({
        identity: { agentId, type: input.type },
        sessionId,
        terminal: { terminalId: terminal.terminalId, name: terminal.name },
        lifecycle: { status: "starting", startedAt: occurredAt },
        resultDelivery,
        ...(attended ? { attended: true as const } : {}),
        telemetry: EMPTY_TELEMETRY,
        ...(input.chrome === true ? { chromeEnabled: true as const } : {}),
        ...(input.issues === undefined ? {} : { issueNumbers: input.issues }),
        ...(input.expectsUncommittedTree === true ? { expectsUncommittedTree: true } : {}),
        // This policy is not derivable from the role: a fresh pr-doctor launched
        // by `review_pr` is user-driven and deliberately unrestricted.
        ...(origin === "auto-run" ? { autoRunRestricted: true as const } : {}),
        ...(cwd === undefined ? {} : { cwd }),
      }, occurredAt);
      this.options.fleet.transition(agentId, { status: "running", startedAt: occurredAt }, occurredAt);
      if (returnTargetAgentId !== undefined && this.options.fleet.get(returnTargetAgentId) !== undefined) {
        this.#foregroundReturnTargets.set(agentId, returnTargetAgentId);
      }
      return { agentId, sessionId, terminalId: terminal.terminalId };
    } catch (error) {
      this.options.lease.release(agentId, occurredAt, "launch failed");
      if (!terminalStarted) await this.options.spills.remove?.(agentId).catch(() => undefined);
      throw error;
    }
  }

  #acquire(capability: WriteCapability, agentId: AgentId, sessionId: SessionId, occurredAt: IsoTimestamp, reason: string): void {
    const acquisition = this.options.lease.acquire(capability, { agentId, sessionId }, occurredAt, reason);
    if (acquisition.acquired) return;
    if (this.#recoverStaleLease(acquisition.holder, occurredAt)) {
      const retried = this.options.lease.acquire(capability, { agentId, sessionId }, occurredAt, reason);
      if (retried.acquired) return;
    }
    throw new DelegationError(
      "lease-conflict",
      `Write lease is held by ${acquisition.holder.agentId} since ${acquisition.holder.acquiredAt}`,
      { holder: acquisition.holder, ageMs: acquisition.ageMs },
    );
  }

  #recoverStaleLease(holder: WriteLeaseHolder, occurredAt: IsoTimestamp): boolean {
    const observation: LeaseHolderObservation = {
      terminal: this.options.terminals.liveTerminalForAgent(holder.agentId) === undefined ? "closed" : "open",
      // No observer wired means liveness is unobservable, not absent.
      session: this.options.sessions?.observe(holder.agentId) ?? "live",
    };
    const recovered = this.options.lease.recoverStale(
      observation,
      occurredAt,
      `holder ${holder.agentId} is gone (terminal ${observation.terminal}, session ${observation.session})`,
    );
    if (recovered) {
      this.options.onStaleLeaseRecovered?.(holder, observation);
    }
    return recovered;
  }

  #waitForResult(agentId: AgentId, signal?: AbortSignal): Promise<WorkerResult> {
    const existing = this.options.fleet.takeBlockingResult(agentId, this.#timestamp());
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.#waiters.delete(agentId);
        this.#foregroundReturnTargets.delete(agentId);
        reject(new DelegationError("aborted", `Foreground wait for ${agentId} was aborted`));
      };
      if (signal?.aborted) return abort();
      this.#waiters.set(agentId, (result) => {
        signal?.removeEventListener("abort", abort);
        this.options.fleet.takeBlockingResult(agentId, this.#timestamp());
        resolve(result);
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #foregroundResult(agentId: AgentId, result: WorkerResult): unknown {
    const session = this.#requireAgent(agentId);
    return {
      agentId,
      sessionId: session.sessionId,
      status: session.lifecycle.status,
      result: result.outcome === "succeeded" ? result.lastAssistantMessage : result.failure,
      telemetry: result.telemetry,
    };
  }

  #requireAgent(agentId: AgentId): AgentSession {
    const session = this.options.fleet.get(agentId);
    if (session === undefined) throw new DelegationError("unknown-agent", `Unknown agent ${agentId}`);
    return session;
  }

  /** Spread so an unset command leaves the field absent under exactOptionalPropertyTypes. */
  #command(): { readonly command?: readonly string[] } {
    const command = this.options.command?.();
    return command === undefined ? {} : { command };
  }

  /** Spread like `#command`, so an unset level stays absent rather than explicitly undefined. */
  #effort(): { readonly effort?: EffortLevel } {
    const effort = this.options.effort?.();
    return effort === undefined ? {} : { effort };
  }

  #infrastructureDenials(mcpConfigPath: string | undefined): readonly string[] {
    const denied = this.options.disallowedTools ?? [];
    return mcpConfigPath === undefined
      ? denied
      : denied.filter((rule) => rule.trim() !== "mcp__aboard__*");
  }

  #timestamp(): IsoTimestamp {
    return this.#now().toISOString() as IsoTimestamp;
  }
}
