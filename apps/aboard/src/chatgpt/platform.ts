import { randomUUID } from "node:crypto";

import type { CommandRunner } from "../claude/preflight.js";
import type { SessionId } from "../domain/contracts.js";
import type { AgentPlatform, AgentPlatformCapabilities, PlatformLaunchPlan, PlatformLaunchRequest, PlatformLifecycleAssets, PlatformResumeRequest, PlatformSessionIdentity } from "../platform/agent-platform.js";
import type { LifecycleObservation, PlatformLifecycleKind } from "../platform/lifecycle.js";
import { normalizeChatGptLifecycle } from "./lifecycle.js";
import { planChatGptLaunch } from "./launch.js";
import { ChatGptCommandProbe } from "./preflight.js";

export class ChatGptAgentPlatform implements AgentPlatform {
  public readonly id = "chatgpt" as const;
  public readonly capabilities: AgentPlatformCapabilities = {
    sessionIdentity: "runtime-assigned",
    promptDelivery: ["none", "inline", "spilled"],
    lifecycle: ["start", "stop", "end"],
    models: [],
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
  };
  public readonly lifecycleAssets: PlatformLifecycleAssets;
  readonly #probe: ChatGptCommandProbe;

  public constructor(private readonly options: { readonly commandRunner: CommandRunner; readonly lifecycleAssets: PlatformLifecycleAssets; readonly preflightTimeoutMs?: number; readonly sessionIdFactory?: () => SessionId }) {
    this.lifecycleAssets = options.lifecycleAssets;
    this.#probe = new ChatGptCommandProbe({ run: options.commandRunner, ...(options.preflightTimeoutMs === undefined ? {} : { timeoutMs: options.preflightTimeoutMs }) });
  }
  public createSession(): PlatformSessionIdentity { return { sessionId: (this.options.sessionIdFactory ?? (() => randomUUID() as SessionId))(), binding: "provisional" }; }
  public bindSession(current: PlatformSessionIdentity, observed: SessionId): SessionId | undefined { return current.binding === "provisional" ? observed : current.sessionId === observed ? observed : undefined; }
  public normalizeLifecycle(kind: PlatformLifecycleKind, payload: unknown): LifecycleObservation { return normalizeChatGptLifecycle(kind, payload); }
  public planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan { return planChatGptLaunch(request); }
  public planSessionResume(_request: PlatformResumeRequest): PlatformLaunchPlan { throw new Error("ChatGPT session resume is not available yet"); }
  public preflight(command: readonly string[]): Promise<void> { return this.#probe.require(command); }
  public isResumable(_sessionId: SessionId, _cwd: string): Promise<boolean> { return Promise.resolve(false); }
}
