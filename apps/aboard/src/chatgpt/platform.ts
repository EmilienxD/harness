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

/**
 * Disabled on purpose, and retained rather than deleted.
 *
 * Browser tooling is user-configured and provider-neutral: an `[AI]-chrome`
 * worker is told to use a real browser if it has a tool for it and to skip the
 * step otherwise. Refusing to launch because no ChatGPT tool server declares a
 * `chrome` backend contradicts that policy, and it strands a worker whose
 * browser tool is an MCP server this probe cannot see. `ChatGptBrowserProbe`
 * stays wired and tested so enforcement can come back by flipping this flag,
 * but every path guarded by it is currently dead code.
 */
const ENFORCE_CHROME_BACKEND = false;

export class ChatGptAgentPlatform implements AgentPlatform {
  public readonly id = "chatgpt" as const;
  public readonly displayName = "Codex";
  public readonly icon = "openai";
  public readonly capabilities: AgentPlatformCapabilities = {
    sessionIdentity: "runtime-assigned",
    promptDelivery: ["none", "inline", "spilled"],
    lifecycle: ["start", "stop", "end", "compaction"],
    models: [],
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  };
  public readonly lifecycleAssets: PlatformLifecycleAssets;
  readonly #commandProbe: ChatGptCommandProbe;
  readonly #sessionProbe: Pick<ChatGptSessionProbe, "inspect">;
  readonly #policyProbe: Pick<ChatGptPolicyProbe, "require">;
  readonly #browserProbe: Pick<ChatGptBrowserProbe, "require">;

  public constructor(private readonly options: { readonly commandRunner: CommandRunner; readonly lifecycleAssets: PlatformLifecycleAssets; readonly approveHooks?: () => Promise<boolean>; readonly preflightTimeoutMs?: number; readonly sessionIdFactory?: () => SessionId; readonly sessionProbe?: Pick<ChatGptSessionProbe, "inspect">; readonly policyProbe?: Pick<ChatGptPolicyProbe, "require">; readonly browserProbe?: Pick<ChatGptBrowserProbe, "require"> }) {
    this.lifecycleAssets = options.lifecycleAssets;
    this.#commandProbe = new ChatGptCommandProbe({ run: options.commandRunner, ...(options.preflightTimeoutMs === undefined ? {} : { timeoutMs: options.preflightTimeoutMs }) });
    this.#sessionProbe = options.sessionProbe ?? new ChatGptSessionProbe({ ...(options.preflightTimeoutMs === undefined ? {} : { timeoutMs: options.preflightTimeoutMs }) });
    this.#policyProbe = options.policyProbe ?? new ChatGptPolicyProbe();
    this.#browserProbe = options.browserProbe ?? new ChatGptBrowserProbe();
  }
  public createSession(): PlatformSessionIdentity { return { sessionId: (this.options.sessionIdFactory ?? (() => randomUUID() as SessionId))(), binding: "provisional" }; }
  public bindSession(current: PlatformSessionIdentity, observed: SessionId): SessionId | undefined { return current.binding === "provisional" ? observed : current.sessionId === observed ? observed : undefined; }
  public normalizeLifecycle(kind: PlatformLifecycleKind, payload: unknown): LifecycleObservation { return normalizeChatGptLifecycle(kind, payload); }

  /** ChatGPT takes structured config values, so every neutral restriction is representable. */
  public requireEnforceableRestrictions(): void {}
  public planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan { return planChatGptLaunch(request); }
  public planSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan { return planChatGptSessionResume(request); }
  public async preflight(plan: PlatformLaunchPlan, context?: Parameters<CommandRunner>[3]): Promise<void> {
    const command = await this.#commandProbe.require(plan.command, context);
    if (plan.permissionProfile !== undefined) requirePermissionProfileVersion(command.version);
    await this.#policyProbe.require(plan.agentType, plan.permissionProfile);
    if (plan.args.includes("--dangerously-bypass-hook-trust") && this.options.approveHooks !== undefined
      && !await this.options.approveHooks()) {
      throw Object.assign(new Error("ChatGPT requires workspace hook consent for Aboard to observe session startup. Launch again to allow configured hooks."), { name: "SessionStartCancelledError" });
    }
    // Dead while ENFORCE_CHROME_BACKEND is false; see the note above it.
    if (ENFORCE_CHROME_BACKEND && plan.chromeRequired === true) await this.#browserProbe.require(plan.agentType);
  }
  public async isResumable(sessionId: SessionId, cwd: string, command?: readonly string[]): Promise<boolean> {
    return (await this.#sessionProbe.inspect(sessionId, cwd, command)).state === "resumable";
  }
}
