import { ClaudeCommandProbe, type CommandRunner } from "./preflight.js";
import { planLaunch, planSessionResume, type LaunchPlanRequest, type SessionResumePlanRequest } from "./launch.js";
import { sessionIsResumable } from "./sessions.js";
import type { AgentPlatform, AgentPlatformCapabilities, PlatformLaunchPlan, PlatformLaunchRequest, PlatformResumeRequest } from "../platform/agent-platform.js";
import type { SessionId } from "../domain/contracts.js";

export interface ClaudeAgentPlatformOptions {
  readonly commandRunner: CommandRunner;
  readonly preflightTimeoutMs?: number;
  readonly resumable?: (sessionId: SessionId, cwd: string) => Promise<boolean>;
}

export class ClaudeAgentPlatform implements AgentPlatform {
  public readonly id = "claude" as const;
  public readonly capabilities: AgentPlatformCapabilities = {
    sessionIdentity: "client-assigned",
    promptDelivery: ["none", "inline", "spilled"],
    lifecycle: ["start", "stop", "end"],
    models: ["haiku", "sonnet", "opus"],
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  };
  readonly #probe: ClaudeCommandProbe;

  public constructor(private readonly options: ClaudeAgentPlatformOptions) {
    this.#probe = new ClaudeCommandProbe({
      run: options.commandRunner,
      ...(options.preflightTimeoutMs === undefined ? {} : { timeoutMs: options.preflightTimeoutMs }),
    });
  }

  public planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan {
    return { ...planLaunch({ ...request, configuration: request.configuration as LaunchPlanRequest["configuration"] }), platform: this.id };
  }

  public planSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan {
    return { ...planSessionResume({ ...request, configuration: request.configuration as SessionResumePlanRequest["configuration"] }), platform: this.id };
  }

  public preflight(command: readonly string[]): Promise<void> { return this.#probe.require(command); }
  public isResumable(sessionId: SessionId, cwd: string): Promise<boolean> {
    return (this.options.resumable ?? sessionIsResumable)(sessionId, cwd);
  }
}
