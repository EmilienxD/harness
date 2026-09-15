import { randomUUID } from "node:crypto";

import type { CommandRunner } from "../platform/preflight.js";
import type { SessionId } from "../domain/contracts.js";
import type { AgentPlatform, AgentPlatformCapabilities, PlatformLaunchPlan, PlatformLaunchRequest, PlatformLifecycleAssets, PlatformResumeRequest, PlatformSessionIdentity } from "../platform/agent-platform.js";
import type { LifecycleObservation, PlatformLifecycleKind } from "../platform/lifecycle.js";
import { ChatGptBrowserProbe } from "./browser.js";
import { normalizeChatGptLifecycle } from "./lifecycle.js";
import { planChatGptLaunch, planChatGptSessionResume } from "./launch.js";
import { ChatGptPolicyProbe } from "./policy.js";
import { ChatGptCommandProbe, requirePermissionProfileVersion } from "./preflight.js";
import { ChatGptSessionProbe } from "./sessions.js";

export class ChatGptAgentPlatform implements AgentPlatform {
  public readonly id = "chatgpt" as const;
  public readonly capabilities: AgentPlatformCapabilities = {
    sessionIdentity: "runtime-assigned",
    promptDelivery: ["none", "inline", "spilled"],
    lifecycle: ["start", "stop", "end", "compaction"],
    models: [],
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
  };
  public readonly lifecycleAssets: PlatformLifecycleAssets;
  readonly #commandProbe: ChatGptCommandProbe;
  readonly #sessionProbe: Pick<ChatGptSessionProbe, "inspect">;
  readonly #policyProbe: Pick<ChatGptPolicyProbe, "require">;
  readonly #browserProbe: Pick<ChatGptBrowserProbe, "require">;

  public constructor(private readonly options: { readonly commandRunner: CommandRunner; readonly lifecycleAssets: PlatformLifecycleAssets; readonly preflightTimeoutMs?: number; readonly sessionIdFactory?: () => SessionId; readonly sessionProbe?: Pick<ChatGptSessionProbe, "inspect">; readonly policyProbe?: Pick<ChatGptPolicyProbe, "require">; readonly browserProbe?: Pick<ChatGptBrowserProbe, "require"> }) {
    this.lifecycleAssets = options.lifecycleAssets;
    this.#commandProbe = new ChatGptCommandProbe({ run: options.commandRunner, ...(options.preflightTimeoutMs === undefined ? {} : { timeoutMs: options.preflightTimeoutMs }) });
    this.#sessionProbe = options.sessionProbe ?? new ChatGptSessionProbe({ ...(options.preflightTimeoutMs === undefined ? {} : { timeoutMs: options.preflightTimeoutMs }) });
    this.#policyProbe = options.policyProbe ?? new ChatGptPolicyProbe();
    this.#browserProbe = options.browserProbe ?? new ChatGptBrowserProbe();
  }
  public createSession(): PlatformSessionIdentity { return { sessionId: (this.options.sessionIdFactory ?? (() => randomUUID() as SessionId))(), binding: "provisional" }; }
  public bindSession(current: PlatformSessionIdentity, observed: SessionId): SessionId | undefined { return current.binding === "provisional" ? observed : current.sessionId === observed ? observed : undefined; }
  public normalizeLifecycle(kind: PlatformLifecycleKind, payload: unknown): LifecycleObservation { return normalizeChatGptLifecycle(kind, payload); }

  /** Codex takes structured config values, so every neutral restriction is representable. */
  public requireEnforceableRestrictions(): void {}
  public planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan { return planChatGptLaunch(request); }
  public planSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan { return planChatGptSessionResume(request); }
  public async preflight(plan: PlatformLaunchPlan): Promise<void> {
    const command = await this.#commandProbe.require(plan.command);
    if (plan.permissionProfile !== undefined) requirePermissionProfileVersion(command.version);
    await this.#policyProbe.require(plan.agentType, plan.permissionProfile);
    if (plan.chromeRequired === true) await this.#browserProbe.require(plan.agentType);
  }
  public async isResumable(sessionId: SessionId, cwd: string, command?: readonly string[]): Promise<boolean> {
    return (await this.#sessionProbe.inspect(sessionId, cwd, command)).state === "resumable";
  }
}
