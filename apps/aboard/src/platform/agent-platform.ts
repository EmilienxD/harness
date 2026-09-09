import type {
  LaunchPlan,
  LaunchPlanRequest,
  RuntimeFile,
  SessionResumePlanRequest,
} from "../claude/launch.js";
import { AGENT_PLATFORM_IDS, type AgentPlatformId, type SessionId } from "../domain/contracts.js";
import type { LifecycleObservation, PlatformLifecycleKind } from "./lifecycle.js";

export interface PlatformSessionIdentity {
  readonly sessionId: SessionId;
  readonly binding: "provisional" | "bound";
}

export interface PlatformLifecycleAssets {
  readonly settings: string;
  readonly script: string;
}

export { AGENT_PLATFORM_IDS } from "../domain/contracts.js";
export type { AgentPlatformId } from "../domain/contracts.js";

export interface ConfiguredLaunch {
  readonly platform: AgentPlatformId;
  /** Opaque to shared orchestration; only the selected adapter interprets it. */
  readonly settings: unknown;
}

export interface AgentPlatformCapabilities {
  readonly sessionIdentity: "client-assigned" | "runtime-assigned";
  readonly promptDelivery: readonly ("none" | "inline" | "spilled")[];
  readonly lifecycle: readonly ("start" | "stop" | "end" | "compaction" | "failure")[];
  readonly models: readonly string[];
  readonly reasoningEfforts: readonly string[];
}

export type PlatformLaunchPlan = LaunchPlan & { readonly platform: AgentPlatformId };
export type PlatformLaunchRequest = Omit<LaunchPlanRequest, "configuration"> & { readonly configuration: unknown };
export type PlatformResumeRequest = Omit<SessionResumePlanRequest, "configuration"> & { readonly configuration: unknown };

/** Provider boundary used by shared orchestration. */
export interface AgentPlatform {
  readonly id: AgentPlatformId;
  readonly capabilities: AgentPlatformCapabilities;
  readonly lifecycleAssets: PlatformLifecycleAssets;
  createSession(): PlatformSessionIdentity;
  /** Returns the canonical id, or undefined when the observation is stale. */
  bindSession(current: PlatformSessionIdentity, observed: SessionId): SessionId | undefined;
  normalizeLifecycle(kind: PlatformLifecycleKind, payload: unknown): LifecycleObservation;
  planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan;
  planSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan;
  preflight(plan: PlatformLaunchPlan): Promise<void>;
  isResumable(sessionId: SessionId, cwd: string, command?: readonly string[]): Promise<boolean>;
}

export interface PromptSpillStore {
  write(file: RuntimeFile, root?: string): Promise<string>;
  prepare(plan: PlatformLaunchPlan, root?: string): Promise<void>;
  remove?(agentId: string): Promise<void>;
  prune?(retainedAgentIds: ReadonlySet<string>, retainedTaskAgentIds?: ReadonlySet<string>): Promise<void>;
}

export type {
  EffortLevel,
  LaunchConfiguration,
  LaunchPlan,
  LaunchPlanRequest,
  SessionResumePlanRequest,
  SessionWrapperLayout,
} from "../claude/launch.js";
export type { ResolvedPrompt } from "../claude/prompts.js";
export type { ShellKind } from "../claude/shell.js";
export type { TerminalController } from "../claude/terminals.js";
