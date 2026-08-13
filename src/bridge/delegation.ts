import type { EffortLevel, LaunchConfiguration, WorkerPermissionMode } from "../claude/launch.js";
import { planLaunch, planSessionResume } from "../claude/launch.js";
import type { ResolvedPrompt } from "../claude/prompts.js";
import type { PromptSpillStore } from "../claude/spill.js";
import type { ShellKind } from "../claude/shell.js";
import type { TerminalController } from "../claude/terminals.js";
import type { WriteCapability } from "../domain/capability.js";
import {
  type AgentId,
  type AgentSession,
  type AgentTelemetry,
  type AgentType,
  type IsoTimestamp,
  type SessionId,
  type WorkerResult,
} from "../domain/contracts.js";
import { FleetRegistry } from "../domain/fleet.js";
import { WriteLease, type WriteLeaseHolder } from "../domain/lease.js";
import type { SessionWrapperLayout } from "../claude/launch.js";
import { sessionIsResumable } from "../claude/sessions.js";

export interface DelegationLaunchInput {
  readonly type: Exclude<AgentType, "manager">;
  readonly prompt?: string;
  readonly description: string;
  readonly issue?: number;
  readonly pullRequest?: number;
  readonly focus?: string;
  /**
   * Set only by the auto-run engine. It records that this agent's contract ends
   * at "the working tree contains the change", so a dirty tree at Stop is
   * success rather than a `no-commit` failure — the engine commits
   * (`docs/auto-implementation.md` §13).
   */
  readonly expectsUncommittedTree?: boolean;
}

/** What the engine needs back from a launch: the handles plus the result. */
export interface AutomatedLaunchOutcome {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: AgentSession["terminal"]["terminalId"];
  readonly result: WorkerResult;
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
  /**
   * `interactive` is the launch's mode, not the type's: a dual-mode builtin
   * type launched interactively needs no opening message any more than a
   * brainstormer does, and an automated launch always needs one.
   */
  resolve(input: DelegationLaunchInput, options: { readonly interactive: boolean }): Promise<ResolvedPrompt | undefined>;
}

export interface DelegationCoordinatorOptions {
  readonly workspaceRoot: string;
  /** Tests transcript availability before deciding between resume and a fresh session. */
  readonly isResumable?: (sessionId: SessionId, cwd: string) => Promise<boolean>;
  readonly fleet: FleetRegistry;
  readonly lease: WriteLease;
  readonly terminals: TerminalController;
  readonly configurations: DelegationConfigurationSource;
  readonly prompts: DelegationPromptResolver;
  readonly spills: PromptSpillStore;
  readonly managerAgentId: AgentId;
  readonly shell: ShellKind;
  readonly permissionMode: WorkerPermissionMode;
  /**
   * `aboard.launch.claudeCommand` tokens. Read at launch time so a settings
   * change applies to the next agent without reloading the window.
   */
  readonly command?: () => readonly string[] | undefined;
  /** Verifies the Claude command runs at all; throws to refuse the launch. */
  readonly preflight?: (command: readonly string[] | undefined) => Promise<void>;
  /**
   * `aboard.launch.effort`, read at launch time for the same reason as
   * `command`. It is the session level; a worker whose definition declares
   * `effort:` overrides it from its own frontmatter.
   */
  readonly effort?: () => EffortLevel | undefined;
  readonly agentIdFactory: () => AgentId;
  readonly sessionIdFactory: () => SessionId;
  readonly now?: () => Date;
  readonly maxInlinePromptChars?: number;
  /**
   * Proof-of-life window for every delegated launch. If no SessionStart hook
   * fires inside this window the terminal is killed as a failed start; the
   * write lease is released by the launch-failure path on timeout.
   */
  readonly startupTimeoutMs?: number;
  /**
   * Launch-through-wrapper layout: the wrapper owns a lock-marker file per
   * agent for the child's exact lifetime, which the bridge polls for liveness
   * instead of scraping process ids. Absent = launch unwrapped.
   */
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
    const launched = await this.#launch(input, { mode: "tool-result" });
    const result = await this.#waitForResult(launched.agentId, signal);
    return this.#foregroundResult(launched.agentId, result);
  }

  /**
   * The auto-run engine's launch path. It is `run` plus the terminal id, which
   * the engine needs to close the terminal at cleanup; `tool-result` delivery is
   * correct because the engine is in-process async code and genuinely is the
   * blocked caller that mode describes (`docs/auto-implementation.md` §2).
   */
  public async runAutomated(input: DelegationLaunchInput, signal?: AbortSignal): Promise<AutomatedLaunchOutcome> {
    const launched = await this.#launch(input, { mode: "tool-result" });
    const result = await this.#waitForResult(launched.agentId, signal);
    return { ...launched, result };
  }

  /** Interactive launch for the engine, typed to the handles it actually uses. */
  public async launchInteractive(input: DelegationLaunchInput): Promise<InteractiveLaunchHandles> {
    return this.#launch(input, { mode: "none" });
  }

  /** Reopens a persisted active worker after the extension host restarted. */
  public async resumePersisted(session: AgentSession): Promise<InteractiveLaunchHandles> {
    if (session.identity.type === "manager") {
      throw new DelegationError("unknown-agent", "The Manager has its own lifecycle");
    }
    if (session.identity.type === "webresearcher") {
      throw new DelegationError(
        "unresumable-session",
        "A webresearcher cannot be restored after its result caller is gone; launch a fresh research task instead",
      );
    }
    // The definition is required, not merely useful: a resume re-passes the
    // system prompt and tool list, and reopening the session without them
    // yields Claude Code's default persona holding every default tool.
    const configuration = await this.options.configurations.get(session.identity.type);
    const resumable = await (this.options.isResumable ?? sessionIsResumable)(session.sessionId, this.options.workspaceRoot);
    if (!resumable) {
      throw new DelegationError("unresumable-session", `Session ${session.sessionId} has no Claude conversation to resume`);
    }
    const plan = planSessionResume({
      agentId: session.identity.agentId,
      sessionId: session.sessionId,
      agentType: session.identity.type,
      shell: this.options.shell,
      permissionMode: this.options.permissionMode,
      configuration,
      ...this.#effort(),
      ...this.#command(),
      ...(this.options.wrapper === undefined ? {} : { wrapper: this.options.wrapper }),
    });
    // `plan.command`, not the setting: an agent whose definition declares
    // `command:` runs that program, so probing the configured default would
    // clear a command this launch never uses.
    await this.options.preflight?.(plan.command);
    const occurredAt = this.#timestamp();
    this.#acquire(plan.writeCapability, session.identity.agentId, session.sessionId, occurredAt, "restore persisted agent");
    try {
      if (plan.systemPrompt !== undefined) await this.options.spills.write(plan.systemPrompt);
      const terminal = this.options.terminals.create({
        agentId: session.identity.agentId,
        sessionId: session.sessionId,
        agentType: session.identity.type,
        ...(session.issueNumber === undefined ? {} : { issueNumber: session.issueNumber }),
        name: session.terminal.name,
        initialCommand: plan.commandLine,
        // The extension-host waiter that owned an automated result is gone.
        // Restoration therefore hands every worker to the user instead of
        // pretending the interrupted workflow can still receive its result.
        deliversResult: false,
        focus: false,
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      });
      this.options.fleet.reattach(
        session.identity.agentId,
        { terminalId: terminal.terminalId, name: terminal.name },
        occurredAt,
        undefined,
        { mode: "none" },
      );
      this.options.fleet.transition(session.identity.agentId, { status: "running", startedAt: occurredAt }, occurredAt);
      return { agentId: session.identity.agentId, sessionId: session.sessionId, terminalId: terminal.terminalId };
    } catch (error) {
      this.options.lease.release(session.identity.agentId, occurredAt, "persisted agent restore failed");
      throw error;
    }
  }

  public async spawn(input: DelegationLaunchInput): Promise<unknown> {
    const launched = await this.#launch(input, {
      mode: "mailbox",
      managerAgentId: this.options.managerAgentId,
    });
    return { ...launched, status: "running" };
  }

  public async spawnInteractive(input: DelegationLaunchInput): Promise<unknown> {
    const launched = await this.#launch(input, { mode: "none" });
    return {
      ...launched,
      handoff: `Terminal focused for ${input.description}. Continue directly with the user; no agent result will be returned.`,
    };
  }

  public releaseLease(reason: string): unknown {
    const holder = this.options.lease.current();
    const released = this.options.lease.forceRelease(this.#timestamp(), reason);
    return { released, holder: holder ?? null, reason };
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

  async #launch(input: DelegationLaunchInput, resultDelivery: AgentSession["resultDelivery"]): Promise<{
    readonly agentId: AgentId;
    readonly sessionId: SessionId;
    readonly terminalId: AgentSession["terminal"]["terminalId"];
  }> {
    const agentId = this.options.agentIdFactory();
    const sessionId = this.options.sessionIdFactory();
    // Interactive is the launch's delivery mode, derivable from nothing else:
    // `general-purpose` and `Explore` run in either mode.
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
      permissionMode: this.options.permissionMode,
      configuration,
      prompt,
      ...this.#command(),
      ...this.#effort(),
      maxInlinePromptChars: this.options.maxInlinePromptChars,
      ...(this.options.wrapper === undefined ? {} : { wrapper: this.options.wrapper }),
    });
    // Before anything is registered or leased: a command that cannot run is a
    // refused launch, not a terminal full of shell errors and a fleet entry
    // waiting on a session that will never start. The plan's command is what
    // actually runs — a definition's `command:` where it declares one.
    await this.options.preflight?.(plan.command);
    const occurredAt = this.#timestamp();
    this.#acquire(plan.writeCapability, agentId, sessionId, occurredAt, "launch agent");
    try {
      if (plan.systemPrompt !== undefined) await this.options.spills.write(plan.systemPrompt);
      if (plan.spill !== undefined) await this.options.spills.write(plan.spill);
      const terminal = this.options.terminals.create({
        agentId,
        sessionId,
        agentType: input.type,
        ...(input.issue === undefined ? {} : { issueNumber: input.issue }),
        name: `aboard: ${input.description}`,
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
        ...(input.issue === undefined ? {} : { issueNumber: input.issue }),
        ...(input.expectsUncommittedTree === true ? { expectsUncommittedTree: true } : {}),
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
    if (!acquisition.acquired) {
      throw new DelegationError(
        "lease-conflict",
        `Write lease is held by ${acquisition.holder.agentId} since ${acquisition.holder.acquiredAt}`,
        { holder: acquisition.holder, ageMs: acquisition.ageMs },
      );
    }
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
