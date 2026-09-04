export const AGENT_TYPES = [
  "manager",
  "brainstormer",
  "prototyper",
  "webresearcher",
  "implementer",
  "pr-doctor-afk",
  "pr-doctor-hitl",
  "general-purpose",
  "Explore",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const LAUNCHABLE_AGENT_TYPES = AGENT_TYPES.filter((type) => type !== "manager");

export const MCP_LAUNCHABLE_AGENT_TYPES: readonly AgentType[] = LAUNCHABLE_AGENT_TYPES.filter(
  (type) => type !== "implementer" && type !== "pr-doctor-afk" && type !== "pr-doctor-hitl",
);

export const BRAINSTORMER_LAUNCHABLE_AGENT_TYPES = ["Explore", "webresearcher", "prototyper", "brainstormer"] as const;

export const MCP_DEFAULT_AGENT_TYPE: AgentType = "general-purpose";

export const AUTOMATED_AGENT_TYPES = ["webresearcher", "implementer", "pr-doctor-afk", "Explore"] as const;

export function isAutomatedAgentType(type: AgentType): boolean {
  return (AUTOMATED_AGENT_TYPES as readonly AgentType[]).includes(type);
}

export const INTERACTIVE_AGENT_TYPES = ["brainstormer", "prototyper", "pr-doctor-hitl"] as const;

export function isInteractiveAgentType(type: AgentType): boolean {
  return (INTERACTIVE_AGENT_TYPES as readonly AgentType[]).includes(type);
}

export const NAMED_BUILTIN_AGENT_TYPES = ["Explore"] as const;

export function isNamedBuiltinAgentType(type: AgentType): boolean {
  return (NAMED_BUILTIN_AGENT_TYPES as readonly AgentType[]).includes(type);
}

export const NON_RESTORABLE_PERSISTED_AGENT_TYPES = ["webresearcher", "Explore"] as const;

export function isNonRestorablePersistedAgentType(type: AgentType): boolean {
  return (NON_RESTORABLE_PERSISTED_AGENT_TYPES as readonly AgentType[]).includes(type);
}

/** Conversations a live MCP caller may ask to continue after their report lands. */
export const CONTINUABLE_AGENT_TYPES = ["webresearcher", "prototyper", "brainstormer"] as const;

export function isContinuableAgentType(type: AgentType): type is (typeof CONTINUABLE_AGENT_TYPES)[number] {
  return (CONTINUABLE_AGENT_TYPES as readonly AgentType[]).includes(type);
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
  | { readonly mode: "mailbox"; readonly recipientAgentId: AgentId }
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
  /** The user drives this session. Absence is the persisted form of unattended. */
  readonly attended?: true;
  readonly telemetry: AgentTelemetry;
  /** The launch explicitly enabled Claude in Chrome; absence means disabled. */
  readonly chromeEnabled?: true;
  /** Every issue this agent's launch prompt resolved, in the order it was given them. */
  readonly issueNumbers?: readonly number[];
  readonly cwd?: string;
  readonly expectsUncommittedTree?: boolean;
  readonly autoRunRestricted?: true;
  readonly compactSummaries?: readonly string[];
  /** Most recent complete assistant message observed by aboard's Stop hook. */
  readonly lastObservedAssistantMessage?: string;
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
