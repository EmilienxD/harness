import { ClaudeCommandProbe } from "./preflight.js";
import type { CommandRunner } from "../platform/preflight.js";
import { randomUUID } from "node:crypto";
import { planLaunch, planSessionResume, restrictionRules, type LaunchPlanRequest, type SessionResumePlanRequest } from "./launch.js";
import type { LaunchRestrictions } from "../domain/capability.js";
import { sessionIsResumable } from "./sessions.js";
import type { AgentPlatform, AgentPlatformCapabilities, PlatformLaunchPlan, PlatformLaunchRequest, PlatformResumeRequest, PlatformSessionIdentity, PlatformLifecycleAssets } from "../platform/agent-platform.js";
import type { SessionId } from "../domain/contracts.js";
import { normalizeClaudeLifecycle } from "./lifecycle.js";
import type { LifecycleObservation, PlatformLifecycleKind } from "../platform/lifecycle.js";

export interface ClaudeAgentPlatformOptions {
  readonly commandRunner: CommandRunner;
  readonly preflightTimeoutMs?: number;
  readonly sessionIdFactory?: () => SessionId;
  readonly lifecycleAssets: PlatformLifecycleAssets;
  readonly resumable?: (sessionId: SessionId, cwd: string) => Promise<boolean>;
}

export class ClaudeAgentPlatform implements AgentPlatform {
  public readonly id = "claude" as const;
  public readonly displayName = "Claude Code";
  public readonly icon = "claude";
  public readonly capabilities: AgentPlatformCapabilities = {
    sessionIdentity: "client-assigned",
    promptDelivery: ["none", "inline", "spilled"],
    lifecycle: ["start", "stop", "end", "compaction", "failure"],
    models: ["haiku", "sonnet", "opus"],
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  };
  public readonly lifecycleAssets: PlatformLifecycleAssets;
  readonly #probe: ClaudeCommandProbe;

  public constructor(private readonly options: ClaudeAgentPlatformOptions) {
    this.lifecycleAssets = options.lifecycleAssets;
    this.#probe = new ClaudeCommandProbe({
      run: options.commandRunner,
      ...(options.preflightTimeoutMs === undefined ? {} : { timeoutMs: options.preflightTimeoutMs }),
    });
  }

  public planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan {
    return { ...planLaunch({ ...request, configuration: request.configuration as LaunchPlanRequest["configuration"] }), platform: this.id };
  }

  public createSession(): PlatformSessionIdentity {
    return { sessionId: (this.options.sessionIdFactory ?? (() => randomUUID() as SessionId))(), binding: "bound" };
  }

  public bindSession(current: PlatformSessionIdentity, observed: SessionId): SessionId | undefined {
    return current.binding === "bound" && current.sessionId === observed ? observed : undefined;
  }

  public normalizeLifecycle(kind: PlatformLifecycleKind, payload: unknown): LifecycleObservation {
    return normalizeClaudeLifecycle(kind, payload);
  }

  /** The deny rules are the enforcement, so building them is the whole check. */
  public requireEnforceableRestrictions(restrictions: LaunchRestrictions): void {
    restrictionRules(restrictions);
  }

  public planSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan {
    return { ...planSessionResume({ ...request, configuration: request.configuration as SessionResumePlanRequest["configuration"] }), platform: this.id };
  }

  public preflight(plan: PlatformLaunchPlan): Promise<void> { return this.#probe.require(plan.command); }
  public isResumable(sessionId: SessionId, cwd: string): Promise<boolean> {
    return (this.options.resumable ?? sessionIsResumable)(sessionId, cwd);
  }
}
