import type { EffortLevel, LaunchConfiguration } from "../claude/launch.js";
import { planLaunch, planSessionResume } from "../claude/launch.js";
import type { ResolvedPrompt } from "../claude/prompts.js";
import type { PromptSpillStore } from "../claude/spill.js";
import type { ShellKind } from "../claude/shell.js";
import type { TerminalController } from "../claude/terminals.js";
import type { WriteCapability } from "../domain/capability.js";
import {
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
  readonly #now: () => Date;

  public constructor(private readonly options: DelegationCoordinatorOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  public async run(input: DelegationLaunchInput, signal?: AbortSignal): Promise<unknown> {
    const launched = await this.#launch(input, { mode: "tool-result" }, "manager");
    const result = await this.#waitForResult(launched.agentId, signal);
    return this.#foregroundResult(launched.agentId, result);
  }

  public async runAutomated(input: DelegationLaunchInput, signal?: AbortSignal): Promise<AutomatedLaunchOutcome> {
    const launched = await this.#launch(input, { mode: "tool-result" }, "auto-run");
    const result = await this.#waitForResult(launched.agentId, signal);
    return { ...launched, result };
  }

  public async launchInteractive(input: DelegationLaunchInput, origin: LaunchOrigin): Promise<InteractiveLaunchHandles> {
    return this.#launch(input, { mode: "none" }, origin);
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
    const plan = planSessionResume({
      agentId: target.agentId,
      sessionId: target.sessionId,
      agentType: target.type,
      shell: this.options.shell,
      // Reopening hands the session to the user whatever it was: an automated
      // launch's caller is long gone, and this terminal is theirs to type in.
      attended: true,
      ...(target.type === "implementer" && target.chromeEnabled === true ? { chrome: true } : {}),
      configuration,
      disallowedTools: [
        ...(this.options.disallowedTools ?? []),
        ...(target.autoRunRestricted === true ? AUTO_RUN_DISALLOWED_TOOLS : []),
      ],
      ...this.#effort(),
      ...this.#command(),
      ...(target.difficulty === undefined ? {} : { difficulty: target.difficulty }),
      ...(this.options.wrapper === undefined ? {} : { wrapper: this.options.wrapper }),
    });
    await this.options.preflight?.(plan.command);
    const occurredAt = this.#timestamp();
    await this.options.spills.prepare(plan, target.cwd);
    if (this.options.admission?.() === false) throw new Error("aboard runtime is not initialized");
    const terminal = this.options.terminals.create({
      agentId: target.agentId,
      sessionId: target.sessionId,
      agentType: target.type,
      ...(target.issueNumbers === undefined ? {} : { issueNumbers: target.issueNumbers }),
      name: target.terminalName,
      ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
      initialCommand: plan.commandLine,
      deliversResult: false,
      ...(target.focus === undefined ? {} : { focus: target.focus }),
      ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
    });
    if (this.options.fleet.get(target.agentId) === undefined) {
      this.options.fleet.register({
        identity: { agentId: target.agentId, type: target.type },
        sessionId: target.sessionId,
        terminal: { terminalId: terminal.terminalId, name: terminal.name },
        lifecycle: { status: "starting", startedAt: occurredAt },
        resultDelivery: { mode: "none" },
        telemetry: EMPTY_TELEMETRY,
        ...(target.chromeEnabled === true ? { chromeEnabled: true as const } : {}),
        ...(target.issueNumbers === undefined ? {} : { issueNumbers: target.issueNumbers }),
        ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
        ...(target.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
      }, occurredAt);
    } else {
      this.options.fleet.reattach(
        target.agentId,
        { terminalId: terminal.terminalId, name: terminal.name },
        occurredAt,
        undefined,
        { mode: "none" },
      );
    }
    this.options.fleet.transition(target.agentId, { status: "running", startedAt: occurredAt }, occurredAt);
    return { agentId: target.agentId, sessionId: target.sessionId, terminalId: terminal.terminalId };
  }

  public async spawn(input: DelegationLaunchInput): Promise<unknown> {
    const launched = await this.#launch(input, {
      mode: "mailbox",
      managerAgentId: this.options.managerAgentId(),
    }, "manager");
    return { ...launched, status: "running" };
  }

  public async spawnInteractive(input: DelegationLaunchInput): Promise<unknown> {
    const launched = await this.#launch(input, { mode: "none" }, "manager");
    return {
      ...launched,
      handoff: `Terminal focused for ${input.description}. Continue directly with the user; no agent result will be returned.`,
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
    return true;
  }

  async #launch(input: DelegationLaunchInput, resultDelivery: AgentSession["resultDelivery"], origin: LaunchOrigin): Promise<{
    readonly agentId: AgentId;
    readonly sessionId: SessionId;
    readonly terminalId: AgentSession["terminal"]["terminalId"];
  }> {
    const agentId = this.options.agentIdFactory();
    const sessionId = this.options.sessionIdFactory();
    const interactive = resultDelivery.mode === "none";
    const [configuration, prompt] = await Promise.all([
      this.options.configurations.get(input.type),
      this.options.prompts.resolve(input, { interactive }),
    ]);
    const plan = planLaunch({
      agentId,
      sessionId,
      agentType: input.type,
      shell: this.options.shell,
      attended: interactive,
      ...(input.type === "implementer" && input.chrome === true ? { chrome: true } : {}),
      configuration,
      prompt,
      disallowedTools: [
        ...(this.options.disallowedTools ?? []),
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
    if (leaseRequired(origin, interactive)) {
      this.#acquire(plan.writeCapability, agentId, sessionId, occurredAt, leaseReason(origin));
    }
    const cwd = input.isolation?.cwd;
    try {
      await this.options.spills.prepare(plan, cwd);
      if (plan.spill !== undefined) await this.options.spills.write(plan.spill, cwd);
      if (this.options.admission?.() === false) throw new Error("aboard runtime is not initialized");
      const terminal = this.options.terminals.create({
        agentId,
        sessionId,
        agentType: input.type,
        ...(input.issues === undefined ? {} : { issueNumbers: input.issues }),
        name: `aboard: ${input.description}`,
        ...(cwd === undefined ? {} : { cwd }),
        initialCommand: plan.commandLine,
        // Hooks and focus both key on this: a result-delivering session reports
        // over the bridge and runs unfocused; a handed-off one stays silent.
        deliversResult: !interactive,
        // A failed launch prints to the terminal and exits before any hook; the
        // SessionStart pid report is the only trustworthy proof the TUI is up.
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      });
      this.options.fleet.register({
        identity: { agentId, type: input.type },
        sessionId,
        terminal: { terminalId: terminal.terminalId, name: terminal.name },
        lifecycle: { status: "starting", startedAt: occurredAt },
        resultDelivery,
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
      return { agentId, sessionId, terminalId: terminal.terminalId };
    } catch (error) {
      this.options.lease.release(agentId, occurredAt, "launch failed");
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

  #timestamp(): IsoTimestamp {
    return this.#now().toISOString() as IsoTimestamp;
  }
}
