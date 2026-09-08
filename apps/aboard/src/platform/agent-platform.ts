import type {
  LaunchPlan,
  LaunchPlanRequest,
  SessionResumePlanRequest,
} from "../claude/launch.js";
import type { SessionId } from "../domain/contracts.js";

export const AGENT_PLATFORM_IDS = ["claude"] as const;
export type AgentPlatformId = (typeof AGENT_PLATFORM_IDS)[number];

export interface ConfiguredLaunch {
  readonly platform: AgentPlatformId;
  /** Opaque to shared orchestration; only the selected adapter interprets it. */
  readonly settings: unknown;
}

export interface AgentPlatformCapabilities {
  readonly sessionIdentity: "client-assigned" | "runtime-assigned";
  readonly promptDelivery: readonly ("none" | "inline" | "spilled")[];
  readonly lifecycle: readonly ("start" | "stop" | "end")[];
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
  planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan;
  planSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan;
  preflight(command: readonly string[]): Promise<void>;
  isResumable(sessionId: SessionId, cwd: string): Promise<boolean>;
}

export type {
  AutoRunReviewMode,
  EffortLevel,
  LaunchConfiguration,
  LaunchPlan,
  LaunchPlanRequest,
  SessionResumePlanRequest,
  SessionWrapperLayout,
} from "../claude/launch.js";
export type { ResolvedPrompt } from "../claude/prompts.js";
export type { PromptSpillStore } from "../claude/spill.js";
export type { ShellKind } from "../claude/shell.js";
export type { TerminalController } from "../claude/terminals.js";
