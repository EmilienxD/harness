export const AGENT_TYPES = [
  "manager",
  "brainstormer",
  "webresearcher",
  "implementer",
  "pr-doctor-afk",
  "pr-doctor-hitl",
  "general-purpose",
  "Explore",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * Every type the extension may launch. The Manager is excluded: it is created by
 * the extension's own lifecycle, never by a delegation call.
 */
export const LAUNCHABLE_AGENT_TYPES = AGENT_TYPES.filter((type) => type !== "manager");

/**
 * The subset the Manager's `run_agent` MCP tool may launch. `implementer` and
 * both pr-doctors are absent on purpose: they are reachable only through the
 * auto-run engine and `review_pr`, so the loop stays the extension's
 * (`AGENTS.md`). A type the Manager cannot see is a
 * type it cannot bypass the engine with.
 */
export const MCP_LAUNCHABLE_AGENT_TYPES: readonly AgentType[] = LAUNCHABLE_AGENT_TYPES.filter(
  (type) => type !== "implementer" && type !== "pr-doctor-afk" && type !== "pr-doctor-hitl",
);

/**
 * The type `run_agent` assumes when the caller names none. `general-purpose` is
 * the only catch-all in the set — every other launchable type is a narrowed
 * role — so an omitted type is the caller declining to narrow, not an unknown
 * one to reject.
 */
export const MCP_DEFAULT_AGENT_TYPE: AgentType = "general-purpose";

/**
 * Agent types that perform a task and return a result rather than being handed
 * to the user. They are never typed into, so their first prompt is mandatory
 * (spec section 5.3).
 */
export const AUTOMATED_AGENT_TYPES = ["webresearcher", "implementer", "pr-doctor-afk", "Explore"] as const;

export function isAutomatedAgentType(type: AgentType): boolean {
  return (AUTOMATED_AGENT_TYPES as readonly AgentType[]).includes(type);
}

/**
 * Agent types handed to the user instead of reporting back. They never deliver a
 * result — their Stop hook is guarded off — so a caller that waits for one waits
 * forever. Launch them only through the interactive path.
 *
 * `pr-doctor-hitl` belongs here rather than with its `afk` twin: the two share a
 * contract and a tool set, and differ only in that the HITL one stops to ask.
 * The run's continue signal for a HITL issue is the pull request's resolution,
 * never that agent's completion (`AGENTS.md`).
 */
export const INTERACTIVE_AGENT_TYPES = ["brainstormer", "pr-doctor-hitl"] as const;

export function isInteractiveAgentType(type: AgentType): boolean {
  return (INTERACTIVE_AGENT_TYPES as readonly AgentType[]).includes(type);
}

/**
 * Claude Code's named builtin agent launched through `--agent`. aboard's
 * metadata-only profile supplies no prompt or tools, so `--agent <name>`
 * resolves both from the version Claude Code ships; the names deliberately
 * match the builtin exactly, since a project definition of the same name would
 * override it upstream. They are the only types still launched with `--agent`:
 * aboard's own agents are carried on the command line instead, so that nothing
 * in the workspace can discover and spawn them.
 *
 * Explore is automated only: it runs unattended and reports a result.
 */
export const NAMED_BUILTIN_AGENT_TYPES = ["Explore"] as const;

export function isNamedBuiltinAgentType(type: AgentType): boolean {
  return (NAMED_BUILTIN_AGENT_TYPES as readonly AgentType[]).includes(type);
}

/**
 * Automated research sessions return to an in-process caller and have no
 * interactive handoff contract. After the extension host restarts that caller
 * is gone, so reopening the Claude conversation would create a terminal whose
 * result nobody can receive and which the user was never meant to drive.
 *
 * Keep this policy in the domain vocabulary so restore eligibility, fleet UI,
 * and the coordinator cannot drift into contradictory answers.
 */
export const NON_RESTORABLE_PERSISTED_AGENT_TYPES = ["webresearcher", "Explore"] as const;

export function isNonRestorablePersistedAgentType(type: AgentType): boolean {
  return (NON_RESTORABLE_PERSISTED_AGENT_TYPES as readonly AgentType[]).includes(type);
}

export type AgentId = string & { readonly __brand: "AgentId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type TerminalId = string & { readonly __brand: "TerminalId" };
export type IsoTimestamp = string & { readonly __brand: "IsoTimestamp" };

export interface AgentIdentity {
  readonly agentId: AgentId;
  readonly type: AgentType;
}

export interface TerminalReference {
  readonly terminalId: TerminalId;
  readonly name: string;
}

export interface AgentTelemetry {
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly totalToolUseCount: number;
  readonly compactionCount: number;
  readonly resolvedModel?: string;
  readonly usage?: AgentTokenUsage;
}

export interface AgentTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

export interface ChildAgentNode {
  readonly agentId: string;
  readonly parentAgentId: AgentId;
  readonly type: string;
  readonly status: "running" | "completed";
  readonly startedAt: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly result?: string;
  readonly telemetry: AgentTelemetry;
}

export const WORKER_FAILURE_TYPES = [
  "crashed",
  "context-exhausted",
  "permission-denied",
  "no-commit",
  "timeout",
  "killed",
] as const;

export type WorkerFailureType = (typeof WORKER_FAILURE_TYPES)[number];

interface WorkerFailureDetails {
  readonly exitCode: number | null;
  readonly lastAssistantMessage: string | null;
}

export type WorkerFailure =
  | ({ readonly type: "crashed" } & WorkerFailureDetails)
  | ({ readonly type: "context-exhausted" } & WorkerFailureDetails)
  | ({ readonly type: "permission-denied" } & WorkerFailureDetails)
  | ({ readonly type: "no-commit" } & WorkerFailureDetails)
  | ({ readonly type: "timeout" } & WorkerFailureDetails)
  | ({ readonly type: "killed" } & WorkerFailureDetails);

export type AgentLifecycle =
  | { readonly status: "starting"; readonly startedAt: IsoTimestamp }
  | { readonly status: "running"; readonly startedAt: IsoTimestamp }
  | { readonly status: "awaiting-user"; readonly startedAt: IsoTimestamp }
  | {
      readonly status: "completed";
      readonly startedAt: IsoTimestamp;
      readonly finishedAt: IsoTimestamp;
      readonly exitCode: number;
      readonly lastAssistantMessage: string | null;
    }
  | {
      readonly status: "failed";
      readonly startedAt: IsoTimestamp;
      readonly finishedAt: IsoTimestamp;
      readonly failure: WorkerFailure;
    };

export type ResultDelivery =
  | { readonly mode: "tool-result" }
  | { readonly mode: "mailbox"; readonly managerAgentId: AgentId }
  | { readonly mode: "none" };

export type WorkerResult =
  | {
      readonly outcome: "succeeded";
      readonly exitCode: number;
      readonly lastAssistantMessage: string;
      readonly telemetry: AgentTelemetry;
    }
  | {
      readonly outcome: "failed";
      readonly failure: WorkerFailure;
      readonly telemetry: AgentTelemetry;
    };

export interface AgentSession {
  readonly identity: AgentIdentity;
  readonly sessionId: SessionId;
  readonly terminal: TerminalReference;
  readonly lifecycle: AgentLifecycle;
  readonly resultDelivery: ResultDelivery;
  readonly telemetry: AgentTelemetry;
  /** The launch explicitly enabled Claude in Chrome; absence means disabled. */
  readonly chromeEnabled?: true;
  /** Every issue this agent's launch prompt resolved, in the order it was given them. */
  readonly issueNumbers?: readonly number[];
  /**
   * Set only by the auto-run engine. For an agent whose contract ends at "the
   * working tree contains the change", a dirty tree at Stop is the expected
   * success state rather than a `no-commit` failure — the engine commits. It is
   * a property of the agent's contract, not of where its result goes, so it does
   * not live on `ResultDelivery` (`AGENTS.md`).
   */
  readonly expectsUncommittedTree?: boolean;
  readonly compactSummaries?: readonly string[];
  readonly lastResult?: WorkerResult;
}

export interface ManagerPersistenceDto {
  readonly version: 1;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly terminalId: TerminalId;
  readonly updatedAt: IsoTimestamp;
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled domain variant: ${JSON.stringify(value)}`);
}
