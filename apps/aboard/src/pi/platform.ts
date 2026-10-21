import { randomUUID } from "node:crypto";
import type { SessionId } from "../domain/contracts.js";
import type { AgentPlatform, PlatformLifecycleAssets, PlatformLaunchPlan, PlatformLaunchRequest, PlatformResumeRequest, PlatformSessionIdentity } from "../platform/agent-platform.js";
import type { CommandRunner } from "../platform/preflight.js";
import type { LaunchRestrictions } from "../domain/capability.js";
import type { PlatformLifecycleKind } from "../platform/lifecycle.js";
import { normalizePiLifecycle } from "./lifecycle.js";
import { PI_EFFORTS, planPiSession } from "./launch.js";
import { inspectPiSession } from "./sessions.js";

export class PiAgentPlatform implements AgentPlatform {
  public readonly id = "pi" as const;
  public readonly displayName = "Pi";
  public readonly icon = "terminal";
  public readonly capabilities = { sessionIdentity: "runtime-assigned" as const, promptDelivery: ["none", "inline", "spilled"] as const, lifecycle: ["start", "stop", "end", "compaction", "failure"] as const, models: [], reasoningEfforts: PI_EFFORTS };
  public readonly lifecycleAssets: PlatformLifecycleAssets;
  public constructor(private readonly options: { readonly commandRunner: CommandRunner; readonly lifecycleAssets: PlatformLifecycleAssets }) { this.lifecycleAssets = options.lifecycleAssets; }
  public createSession(): PlatformSessionIdentity { return { sessionId: randomUUID() as SessionId, binding: "provisional" }; }
  public bindSession(current: PlatformSessionIdentity, observed: SessionId): SessionId | undefined { return current.binding === "provisional" ? observed : current.sessionId === observed ? observed : undefined; }
  public normalizeLifecycle(kind: PlatformLifecycleKind, payload: unknown) { return normalizePiLifecycle(kind, payload); }
  /** Pi worktrees use working-directory guidance; native guards retain command/tool restrictions. */
  public requireEnforceableRestrictions(_restrictions: LaunchRestrictions): void {}
  public planLaunch(request: PlatformLaunchRequest): PlatformLaunchPlan { return planPiSession(request, "start"); }
  public planSessionResume(request: PlatformResumeRequest): PlatformLaunchPlan { return planPiSession(request, "resume"); }
  public async preflight(plan: PlatformLaunchPlan): Promise<void> {
    const cwd = plan.providerEnvironment?.ABOARD_PI_CWD ?? process.cwd();
    if (plan.kind === "resume" && !await this.isResumable(plan.sessionId, cwd, plan.command)) throw new Error("The saved Pi conversation is missing or does not belong to this project.");
    const forkIndex = plan.args.indexOf("--fork");
    if (forkIndex !== -1 && !await this.isResumable(plan.args[forkIndex + 1] as SessionId, cwd, plan.command)) throw new Error("The source Pi conversation cannot be forked in this project.");
    const [program, ...prefix] = plan.command;
    if (program === undefined) throw new Error("Pi command is empty");
    const result = await this.options.commandRunner(program, [...prefix, "--version"], 10_000);
    if (result.code !== 0 || !/^1\.2\.0(?:\s|$)/u.test(result.stdout.trim())) throw new Error("Aboard Pi integration requires Pi 1.2.0; the configured command did not report that supported version.");
    const index = plan.args.indexOf("--model");
    if (index !== -1) {
      const pattern = plan.args[index + 1]!.toLowerCase();
      const listed = await this.options.commandRunner(program, [...prefix, "--offline", "--no-extensions", "--list-models"], 10_000);
      const models = listed.stdout.split(/\r?\n/u).slice(1).map((line) => line.trim().split(/\s+/u)).filter((row) => row.length >= 2);
      if (listed.code !== 0 || !listed.stdout.startsWith("provider")) throw new Error("Pi has no authenticated models; configure a model before launching Aboard.");
      const exact = models.filter((row) => `${row[0]}/${row[1]}`.toLowerCase() === pattern || row[1]!.toLowerCase() === pattern);
      const matches = exact.length > 0 ? exact : models.filter((row) => `${row[0]}/${row[1]}`.toLowerCase().includes(pattern));
      if (matches.length !== 1) throw new Error(`Pi model ${plan.args[index + 1]} is unavailable or ambiguous; select an exact provider/model ID.`);
      if (`${matches[0]![0]}/${matches[0]![1]}`.toLowerCase() !== pattern) throw new Error(`Select the authenticated Pi model explicitly as ${matches[0]![0]}/${matches[0]![1]}. Bare model patterns may select an unconfigured provider.`);
    }
  }
  public async isResumable(sessionId: SessionId, cwd: string, command?: readonly string[]): Promise<boolean> { return await inspectPiSession(sessionId, cwd, command) !== undefined; }
}
