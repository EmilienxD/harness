/**
 * Aboard session types after the REFACTOR.md redesign:
 * - interactive: Ordinary user-controlled agent TUI
 * - Explore: Read-only exploration session
 * - implementer: Auto Run worker that implements one frozen issue
 * - reviewer: Auto Run worker that reviews (both AFK and HITL use this profile)
 */
export const AGENT_TYPES = [
  "interactive",
  "Explore",
  "implementer",
  "reviewer",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

/** All agent types can be launched by the user or Auto Run */
export const LAUNCHABLE_AGENT_TYPES = AGENT_TYPES;

/** Interactive sessions are user-driven */
export const INTERACTIVE_AGENT_TYPES = ["interactive"] as const;

export function isInteractiveAgentType(type: AgentType): boolean {
  return (INTERACTIVE_AGENT_TYPES as readonly AgentType[]).includes(type);
}

/** Explore is the stable provider-neutral read-only role. */
export const NAMED_BUILTIN_AGENT_TYPES = ["Explore"] as const;

export function isNamedBuiltinAgentType(type: AgentType): boolean {
  return (NAMED_BUILTIN_AGENT_TYPES as readonly AgentType[]).includes(type);
}

/** Auto Run workers: implementer and reviewer */
export const AUTO_RUN_WORKER_TYPES = ["implementer", "reviewer"] as const;

export function isAutoRunWorkerType(type: AgentType): boolean {
  return (AUTO_RUN_WORKER_TYPES as readonly AgentType[]).includes(type);
}

/** Explore sessions are not restored from activity */
export const NON_RESTORABLE_PERSISTED_AGENT_TYPES = ["Explore"] as const;

export function isNonRestorablePersistedAgentType(type: AgentType): boolean {
  return (NON_RESTORABLE_PERSISTED_AGENT_TYPES as readonly AgentType[]).includes(type);
}

export function isAutomatedAgentType(type: AgentType): boolean {
  return type === "Explore" || isAutoRunWorkerType(type);
}

export type AgentId = string & { readonly __brand: "AgentId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type TerminalId = string & { readonly __brand: "TerminalId" };
export type IsoTimestamp = string & { readonly __brand: "IsoTimestamp" };
export const AGENT_PLATFORM_IDS = ["claude", "chatgpt"] as const;
export type AgentPlatformId = (typeof AGENT_PLATFORM_IDS)[number];

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
  readonly platform: AgentPlatformId;
  readonly identity: AgentIdentity;
  readonly sessionId: SessionId;
  readonly sessionBinding: "provisional" | "bound";
  readonly terminal: TerminalReference;
  readonly lifecycle: AgentLifecycle;
  readonly resultDelivery: ResultDelivery;
  /** The user drives this session. Absence is the persisted form of unattended. */
  readonly attended?: true;
  readonly telemetry: AgentTelemetry;
  /** The launch explicitly required the Chrome browser capability; absence means disabled. */
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


export function assertNever(value: never): never {
  throw new Error(`Unhandled domain variant: ${JSON.stringify(value)}`);
}
