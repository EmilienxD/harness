import type { AgentPlatform, AgentPlatformId, ConfiguredLaunch, EffortLevel, PromptSpillStore, ResolvedPrompt, SessionWrapperLayout, ShellKind, TerminalController } from "../platform/agent-platform.js";
import { dirname } from "node:path";
import type { WriteCapability } from "../domain/capability.js";
import {

  isNonRestorablePersistedAgentType,
  type AgentId,
  type AgentSession,
  type AgentTelemetry,
  type AgentType,
  type ExecutionMode,
  type IsoTimestamp,
  type PromptAuthority,
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
import { AUTO_RUN_DISALLOWED_TOOLS } from "../auto/permissions.js";
import { isolationDenyRules, worktreeGitMetadataRoots } from "../auto/worktree.js";
import type { IssueDifficulty } from "../shared/labels.js";

export interface LaunchIsolation {
  readonly cwd: string;
  /** Permission deny rules added to this launch's `--disallowedTools`. */
  readonly denyTools: readonly string[];
  readonly writableRoots: readonly string[];
}

export interface DelegationLaunchInput {
  /** Stable Harness request identity for idempotency and child hook binding. */
  readonly requestId?: string;
  readonly type: AgentType;
  readonly prompt?: string;
  /** Trusted skill invocation selected by an ask-agent delegation boundary. */
  readonly skill?: string;
  /** Persistent configured note, ordered before the per-run guideline. */
  readonly permanentPrompt?: string;
  readonly additionalGuideline?: string;
  readonly description: string;
  /** Every issue whose resolved contract belongs in the opening prompt, in the caller's order. */
  readonly issues?: readonly number[];
  /** How many relation levels of issue context the resolved prompt preloads. */
  readonly issueContextDepth?: number;
  /** Fresh bounded codebase evidence supplied only to an implementer. */
  readonly codebaseContext?: string;
  readonly pullRequest?: number;
  /** Set only by auto-run when the implementer's frozen issue has `[AI]-chrome`. */
  readonly chrome?: true;
  /** Set only by the auto-run engine, and only when the run has its own checkout. */
  readonly isolation?: LaunchIsolation;
  readonly difficulty?: IssueDifficulty;
  readonly executionMode?: ExecutionMode;
  /** Pinned parent for a worker whose successful turn must add exactly one commit. */
  readonly completionCommitStartingSha?: string;
  /** Immutable implementation range for a reviewer working from an uncommitted HITL handoff. */
  readonly reviewRange?: string;
  /** A provider-explicit manual launch may bypass the project's default provider. */
  readonly configuration?: ConfiguredLaunch;
}

/** What the engine needs back from a launch: the handles plus the result. */
export interface AutomatedLaunchOutcome {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: AgentSession["terminal"]["terminalId"];
  readonly result: WorkerResult;
}

export interface ReopenTarget {
  readonly platform: AgentPlatformId;
  readonly agentId: AgentId;
  readonly type: AgentType;
  readonly sessionId: SessionId;
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
  /** Pinned parent retained when continuing an Auto Run completion-commit worker. */
  readonly completionCommitStartingSha?: string;
  readonly reviewRange?: string;
  /** This is the exact automated worker conversation continuing over its preserved edits. */
  readonly workerContinuation?: true;
}

export interface InteractiveLaunchHandles {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: AgentSession["terminal"]["terminalId"];
}

export interface DelegationConfigurationSource {
  get(type: AgentType): Promise<ConfiguredLaunch>;
}

export interface DelegationPromptResolver {
  resolve(input: DelegationLaunchInput, options: { readonly authority: PromptAuthority }): Promise<ResolvedPrompt | undefined>;
}

export interface DelegationCoordinatorOptions {
  /** Runtime admission gate; closed synchronously before reset cleanup begins. */
  readonly admission?: () => boolean;
  readonly workspaceRoot: string;
  /** Absolute mutable-state root supplied by the extension host. */
  readonly runtimeDirectory?: string;
  /** Activation-owned temporary root for prompt files referenced with `@`. */
  readonly promptRoot?: string;
  readonly fleet: FleetRegistry;
  readonly lease: WriteLease;
  readonly terminals: TerminalController;
  readonly sessions?: { observe(agentId: AgentId): SessionObservation };
  readonly onStaleLeaseRecovered?: (holder: WriteLeaseHolder, observation: LeaseHolderObservation) => void;
  readonly configurations: DelegationConfigurationSource;
  /** Installed runtime integrations, selected explicitly by launch.json. */
  readonly platforms: ReadonlyMap<AgentPlatformId, AgentPlatform>;
  readonly prompts: DelegationPromptResolver;
  readonly spills: PromptSpillStore;

  readonly shell: ShellKind;
  /** Infrastructure-level denials applied to every delegated launch and resume. */
  readonly disallowedTools?: readonly string[];
  readonly command?: () => readonly string[] | undefined;
  readonly effort?: () => EffortLevel | undefined;
  readonly agentIdFactory: () => AgentId;
  readonly now?: () => Date;
  readonly maxInlinePromptChars?: number;
  readonly startupTimeoutMs?: number;
  readonly wrapper?: SessionWrapperLayout;
  readonly resolveWorktreeGitMetadataRoots?: (worktreeRoot: string, projectRoot: string) => Promise<readonly string[]>;
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
  return origin === "auto-run" ? "auto-run launched agent" : "user launched agent";
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


  public async runAutomated(input: DelegationLaunchInput, signal?: AbortSignal): Promise<AutomatedLaunchOutcome> {
    const launched = await this.#launch(input, { mode: "tool-result" }, "auto-run", false, "auto-run", "auto-run");
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
    return this.#launch(input, { mode: "none" }, origin, true, "interactive", origin === "auto-run" ? "auto-run" : "user");
  }

  public async launchManual(input: DelegationLaunchInput, mode: "interactive" | "auto"): Promise<InteractiveLaunchHandles> {
    return this.#launch(input, { mode: "none" }, "user", mode === "interactive", mode, "delegation");
  }


  /** Reopens a persisted active worker after the extension host restarted. */
  public async resumePersisted(session: AgentSession): Promise<InteractiveLaunchHandles> {

    // Automated-only research types have no user conversation to hand off, so a
    // restore whose result caller is gone leaves nobody to talk to.
    if (isNonRestorablePersistedAgentType(session.identity.type)) {
      throw new DelegationError(
        "unresumable-session",
        `The ${session.identity.type} session cannot be restored after its result caller is gone; launch a fresh ${session.identity.type} instead`,
      );
    }
    return this.reopen({
      platform: session.platform,
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
    const configured = await this.options.configurations.get(target.type);
    if (configured.platform !== target.platform) {
      throw new DelegationError("unresumable-session", `Session ${target.sessionId} belongs to ${target.platform}, but launch.json selects ${configured.platform}`);
    }
    const platform = this.#platform(target.platform);
    // Where the session ran is where its conversation is: a session that ran in
    // an auto-run's own checkout has no transcript under the workspace at all.
    const cwd = target.cwd ?? this.options.workspaceRoot;
    const attended = target.attended ?? true;
    const writableRoots = target.autoRunRestricted === true && target.cwd !== undefined
      ? await (this.options.resolveWorktreeGitMetadataRoots ?? worktreeGitMetadataRoots)(target.cwd, this.options.workspaceRoot)
      : [];

    const plan = platform.planSessionResume({
      agentId: target.agentId,
      sessionId: target.sessionId,
      agentType: target.type,
      shell: this.options.shell,
      attended,
      ...(target.autoRunRestricted === true ? { autoRunRestricted: true as const } : {}),
      ...(target.type === "implementer" && target.chromeEnabled === true ? { chrome: true } : {}),
      configuration: configured.settings,
      runtimeDirectory: this.options.runtimeDirectory ?? (this.options.wrapper === undefined ? undefined : dirname(dirname(this.options.wrapper.lockPathFor(target.agentId)))),
      ...(this.options.promptRoot === undefined ? {} : { promptRoot: this.options.promptRoot }),
      ...(target.prompt === undefined ? {} : { prompt: target.prompt }),
      maxInlinePromptChars: this.options.maxInlinePromptChars,
      disallowedTools: [
        ...(this.options.disallowedTools ?? []),
        ...(target.autoRunRestricted === true ? AUTO_RUN_DISALLOWED_TOOLS : []),
        ...(target.autoRunRestricted === true && target.cwd !== undefined
          ? isolationDenyRules(this.options.workspaceRoot)
          : []),
      ],
      writableRoots,
      ...this.#effort(),
      ...this.#command(),
      ...(target.difficulty === undefined ? {} : { difficulty: target.difficulty }),
      ...(this.options.wrapper === undefined ? {} : { wrapper: this.options.wrapper }),
    });
    await platform.preflight(plan);
    const resumable = await platform.isResumable(target.sessionId, cwd, plan.command);
    if (!resumable) {
      throw new DelegationError("unresumable-session", `Session ${target.sessionId} has no agent conversation to resume`);
    }
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
        ...(target.completionCommitStartingSha === undefined ? {} : { completionCommitStartingSha: target.completionCommitStartingSha }),
        ...(target.reviewRange === undefined ? {} : { reviewRange: target.reviewRange }),
        ...(target.workerContinuation === true ? { workerContinuation: true as const } : {}),
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
          platform: target.platform,
          identity: { agentId: target.agentId, type: target.type },
          sessionId: target.sessionId,
          sessionBinding: "bound",
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
      if (platform.capabilities.sessionIdentity === "runtime-assigned" && this.options.startupTimeoutMs !== undefined) {
        const startup = this.options.terminals.waitForStartup(target.agentId);
        if (startup === undefined) throw new Error(`No startup proof was armed for runtime-assigned ${platform.id} session ${target.agentId}`);
        await startup;
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
    completionCommitStartingSha?: string,
    reviewRange?: string,
  ): Promise<AutomatedLaunchOutcome> {
    if (session.autoRunRestricted !== true || !["completed", "failed"].includes(session.lifecycle.status)) {
      throw new DelegationError("unresumable-session", `Agent ${session.identity.agentId} is not an ended auto-run session`);
    }
    // The first automated wait receives the result directly from `complete`;
    // discard its retained blocking copy before waiting for the continuation.
    this.options.fleet.takeBlockingResult(session.identity.agentId, this.#timestamp());
    const launched = await this.reopen({
      platform: session.platform,
      agentId: session.identity.agentId,
      type: session.identity.type,
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
      ...(completionCommitStartingSha === undefined ? {} : { completionCommitStartingSha }),
      ...(reviewRange === undefined ? {} : { reviewRange }),
      workerContinuation: true,
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


  async #launch(input: DelegationLaunchInput, resultDelivery: AgentSession["resultDelivery"], origin: LaunchOrigin, attended: boolean, executionMode: ExecutionMode, promptAuthority: PromptAuthority): Promise<{
    readonly agentId: AgentId;
    readonly sessionId: SessionId;
    readonly terminalId: AgentSession["terminal"]["terminalId"];
  }> {
    const agentId = this.options.agentIdFactory();
    const agentType = input.type;
    const [configured, prompt] = await Promise.all([
      input.configuration === undefined ? this.options.configurations.get(agentType) : Promise.resolve(input.configuration),
      this.options.prompts.resolve(input, { authority: promptAuthority }),
    ]);
    const platform = this.#platform(configured.platform);
    const createdSession = platform.createSession();
    const { sessionId } = createdSession;
    const plan = platform.planLaunch({
      agentId,
      sessionId,
      agentType,
      shell: this.options.shell,
      attended,
      ...(origin === "auto-run" ? { autoRunRestricted: true as const } : {}),
      ...(agentType === "implementer" && input.chrome === true ? { chrome: true } : {}),
      configuration: configured.settings,
      runtimeDirectory: this.options.runtimeDirectory ?? (this.options.wrapper === undefined ? undefined : dirname(dirname(this.options.wrapper.lockPathFor(agentId)))),
      ...(this.options.promptRoot === undefined ? {} : { promptRoot: this.options.promptRoot }),
      prompt,
      ...(input.skill === undefined ? {} : { skill: input.skill }),
      disallowedTools: [
        ...(this.options.disallowedTools ?? []),
        ...(origin === "auto-run" ? AUTO_RUN_DISALLOWED_TOOLS : []),
        ...(input.isolation?.denyTools ?? []),
      ],
      writableRoots: input.isolation?.writableRoots ?? [],
      ...this.#command(),
      ...this.#effort(),
      ...(input.difficulty === undefined ? {} : { difficulty: input.difficulty }),
      maxInlinePromptChars: this.options.maxInlinePromptChars,
      ...(this.options.wrapper === undefined ? {} : { wrapper: this.options.wrapper }),
    });
    await platform.preflight(plan);
    const occurredAt = this.#timestamp();
    if (leaseRequired(origin, attended)) {
      this.#acquire(plan.writeCapability, agentId, sessionId, occurredAt, leaseReason(origin));
    }
    const cwd = input.isolation?.cwd;
    let terminalStarted = false;
    try {
      await this.options.spills.prepare(plan, cwd);
      if (plan.spill !== undefined) await this.options.spills.write(plan.spill, cwd);

      if (this.options.admission?.() === false) throw new Error("aboard runtime is not initialized");
      const terminal = this.options.terminals.create({
        agentId,
        sessionId,
        agentType,
        ...(input.issues === undefined ? {} : { issueNumbers: input.issues }),
        ...(input.completionCommitStartingSha === undefined ? {} : { completionCommitStartingSha: input.completionCommitStartingSha }),
        ...(input.reviewRange === undefined ? {} : { reviewRange: input.reviewRange }),
        name: `aboard: ${input.description}`,
        ...(cwd === undefined ? {} : { cwd }),
        initialCommand: plan.commandLine,
        attended,
        executionMode,
        ...(input.requestId === undefined ? {} : { harnessRequestId: input.requestId }),
        // A failed launch prints to the terminal and exits before any hook; the
        // platform's start observation is the only trustworthy proof the session is up.
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      }, (createdTerminal) => {
        this.options.fleet.register({
          platform: platform.id,
          identity: { agentId, type: agentType },
          sessionId,
          sessionBinding: createdSession.binding,
          terminal: { terminalId: createdTerminal.terminalId, name: createdTerminal.name },
          lifecycle: { status: "starting", startedAt: occurredAt },
          resultDelivery,
          executionMode,
          ...(attended ? { attended: true as const } : {}),
          telemetry: EMPTY_TELEMETRY,
          ...(input.chrome === true ? { chromeEnabled: true as const } : {}),
          ...(input.issues === undefined ? {} : { issueNumbers: input.issues }),
          // This policy is not derivable from the stable reviewer identity: a
          // manual review is user-driven and deliberately unrestricted.
          ...(origin === "auto-run" ? { autoRunRestricted: true as const } : {}),
          ...(cwd === undefined ? {} : { cwd }),
        }, occurredAt);
      });
      terminalStarted = true;
      if (platform.capabilities.sessionIdentity === "runtime-assigned" && this.options.startupTimeoutMs !== undefined) {
        const startup = this.options.terminals.waitForStartup(agentId);
        if (startup === undefined) throw new Error(`No startup proof was armed for runtime-assigned ${platform.id} session ${agentId}`);
        await startup;
      }
      const canonicalSessionId = this.options.fleet.get(agentId)?.sessionId ?? sessionId;
      this.options.fleet.transition(agentId, { status: "running", startedAt: occurredAt }, occurredAt);

      return { agentId, sessionId: canonicalSessionId, terminalId: terminal.terminalId };
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


  #requireAgent(agentId: AgentId): AgentSession {
    const session = this.options.fleet.get(agentId);
    if (session === undefined) throw new DelegationError("unknown-agent", `Unknown agent ${agentId}`);
    return session;
  }

  #platform(id: AgentPlatformId): AgentPlatform {
    const platform = this.options.platforms.get(id);
    if (platform === undefined) throw new Error(`No agent platform implementation is registered for ${id}`);
    return platform;
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
