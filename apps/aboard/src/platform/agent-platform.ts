import type {
  LaunchPlan,
  PlatformLaunchRequest,
  PlatformResumeRequest,
  RuntimeFile,
} from "./launch.js";
import type { LaunchRestrictions } from "../domain/capability.js";
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
export type { PlatformLaunchRequest, PlatformResumeRequest } from "./launch.js";

/** Provider boundary used by shared orchestration. */
export interface AgentPlatform {
  readonly id: AgentPlatformId;
  readonly displayName?: string;
  readonly icon?: string;
  readonly capabilities: AgentPlatformCapabilities;
  readonly lifecycleAssets: PlatformLifecycleAssets;
  createSession(): PlatformSessionIdentity;
  /** Returns the canonical id, or undefined when the observation is stale. */
  bindSession(current: PlatformSessionIdentity, observed: SessionId): SessionId | undefined;
  normalizeLifecycle(kind: PlatformLifecycleKind, payload: unknown): LifecycleObservation;
  /**
   * Throws when this provider cannot support the requested launch restrictions.
   * Pi treats protected paths as worktree guidance, with no filesystem sandbox.
   * Orchestration calls it before creating anything a failed run would leave behind.
   */
  requireEnforceableRestrictions(restrictions: LaunchRestrictions): void;
  planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan;
  planSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan;
  preflight(plan: PlatformLaunchPlan, context?: Parameters<import("./preflight.js").CommandRunner>[3]): Promise<void>;
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
  LaunchPlan,
  SessionWrapperLayout,
} from "./launch.js";
export type { ResolvedPrompt } from "../platform/prompts.js";
export type { ShellKind } from "../platform/shell.js";
export type { TerminalController } from "../platform/terminals.js";
