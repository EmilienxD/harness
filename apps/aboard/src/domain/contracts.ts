/**
 * Aboard session types after the REFACTOR.md redesign:
 * - interactive: Ordinary user-controlled agent TUI
 * - explore: Read-only exploration session (Claude's builtin Explore agent on Claude)
 * - prototype, websearch, brainstorm, general: manual delegation identities whose
 *   execution mode is recorded separately from Auto Run worker semantics
 * - address: Auto Run worker that addresses one frozen issue
 * - review: Auto Run worker that reviews (both AFK and HITL use this profile)
 */
export const AGENT_TYPES = [
  "interactive",
  "explore",
  "prototype",
  "websearch",
  "brainstorm",
  "general",
  "address",
  "review",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];
export type ExecutionMode = "interactive" | "auto" | "auto-run" | "loop";
/** Who controls the first message sent to an agent. */
export type PromptAuthority = "auto-run" | "delegation" | "user";

/** All agent types can be launched by the user or Auto Run */
export const LAUNCHABLE_AGENT_TYPES = AGENT_TYPES;

/** Interactive sessions are user-driven */
export const INTERACTIVE_AGENT_TYPES = ["interactive"] as const;

export function isInteractiveAgentType(type: AgentType): boolean {
  return (INTERACTIVE_AGENT_TYPES as readonly AgentType[]).includes(type);
}

/** explore is the stable provider-neutral read-only session type. */
export const NAMED_BUILTIN_AGENT_TYPES = ["explore"] as const;

export function isNamedBuiltinAgentType(type: AgentType): boolean {
  return (NAMED_BUILTIN_AGENT_TYPES as readonly AgentType[]).includes(type);
}

/** Auto Run workers: address and review */
export const AUTO_RUN_WORKER_TYPES = ["address", "review"] as const;

export function isAutoRunWorkerType(type: AgentType): boolean {
  return (AUTO_RUN_WORKER_TYPES as readonly AgentType[]).includes(type);
}

/** explore sessions are not restored from activity */
export const NON_RESTORABLE_PERSISTED_AGENT_TYPES = ["explore"] as const;

export function isNonRestorablePersistedAgentType(type: AgentType): boolean {
  return (NON_RESTORABLE_PERSISTED_AGENT_TYPES as readonly AgentType[]).includes(type);
}

export function isAutomatedAgentType(type: AgentType): boolean {
  return type === "explore" || isAutoRunWorkerType(type);
}

/**
 * One-shot headless execution: a provider process with no terminal, no
 * takeover, and no later resume. Manual delegations choose it explicitly with
 * `auto`; inside Auto Run only exploration qualifies, because its report is
 * read once and discarded. Auto Run workers stay in visible terminals even in
 * AFK mode: the user takes them over, continues them, and accepts their work.
 */
export function isHeadlessExecution(type: AgentType, mode: ExecutionMode | undefined): boolean {
  return mode === "auto" || (mode === "auto-run" && !isAutoRunWorkerType(type));
}

export type AgentId = string & { readonly __brand: "AgentId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type TerminalId = string & { readonly __brand: "TerminalId" };
export type IsoTimestamp = string & { readonly __brand: "IsoTimestamp" };
export const AGENT_PLATFORM_IDS = ["claude", "chatgpt", "pi"] as const;

export function agentPlatformName(platform: AgentPlatformId): string {
  return ({ claude: "Claude", chatgpt: "Codex", pi: "Pi" } as const)[platform];
}
export type AgentPlatformId = (typeof AGENT_PLATFORM_IDS)[number];

export interface AgentIdentity {
  readonly agentId: AgentId;
  readonly type: AgentType;
}

/** The label users see for an agent in the fleet tree and its Claude session title. */
export function agentLabel(identity: AgentIdentity): string {
  return `aboard-${identity.type}-${identity.agentId}`;
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
  /** Execution semantics are independent from the visible fleet identity. */
  readonly executionMode?: ExecutionMode;
  /** The user drives this session. Absence is the persisted form of unattended. */
  readonly attended?: true;
  readonly telemetry: AgentTelemetry;
  /** The launch explicitly required the Chrome browser capability; absence means disabled. */
  readonly chromeEnabled?: true;
  /** Every issue this agent's launch prompt resolved, in the order it was given them. */
  readonly issueNumbers?: readonly number[];
  readonly cwd?: string;
  readonly autoRunRestricted?: true;
  readonly compactSummaries?: readonly string[];
  /** Most recent complete assistant message observed by aboard's Stop hook. */
  readonly lastObservedAssistantMessage?: string;
  readonly lastResult?: WorkerResult;
}


export function assertNever(value: never): never {
  throw new Error(`Unhandled domain variant: ${JSON.stringify(value)}`);
}
