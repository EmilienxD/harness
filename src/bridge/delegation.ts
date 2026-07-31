import type { LaunchConfiguration, WorkerPermissionMode } from "../claude/launch.js";
import { planLaunch } from "../claude/launch.js";
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
  resolve(input: DelegationLaunchInput): Promise<ResolvedPrompt | undefined>;
}

export interface DelegationCoordinatorOptions {
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
  readonly agentIdFactory: () => AgentId;
  readonly sessionIdFactory: () => SessionId;
  readonly now?: () => Date;
  readonly maxInlinePromptChars?: number;
}

export class DelegationError extends Error {
  public constructor(
    public readonly code: "lease-conflict" | "unknown-agent" | "agent-active" | "aborted",
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
    const [configuration, prompt] = await Promise.all([
      this.options.configurations.get(input.type),
      this.options.prompts.resolve(input),
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
      maxInlinePromptChars: this.options.maxInlinePromptChars,
    });
    const occurredAt = this.#timestamp();
    this.#acquire(plan.writeCapability, agentId, sessionId, occurredAt, "launch agent");
    try {
      if (plan.spill !== undefined) await this.options.spills.write(plan.spill);
      const terminal = this.options.terminals.create({
        agentId,
        sessionId,
        agentType: input.type,
        ...(input.issue === undefined ? {} : { issueNumber: input.issue }),
        name: `aboard: ${input.description}`,
        initialCommand: plan.commandLine,
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

  #timestamp(): IsoTimestamp {
    return this.#now().toISOString() as IsoTimestamp;
  }
}
