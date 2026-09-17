import type { AgentType } from "../domain/contracts.js";
import type { ConfiguredLaunch } from "../platform/agent-platform.js";
import { DELEGATION_TASKS, LaunchFileError, type DelegationTask, type PlatformLaunchFile } from "../platform/launch-configuration.js";
import { BY_DIFFICULTY, EFFORT_LEVELS, type DeclaredEffort, type EffortLevel } from "../platform/launch.js";
import type { LaunchConfiguration } from "./launch.js";

const AUTO_RUN_TASKS = ["explore", "address", "review"] as const;
const ROOT_FIELDS = new Set(["command", "interactive", "delegations", "autoRun"]);
const PROFILE_FIELDS = new Set(["model", "effort", "deniedTools"]);
const MODELS = ["haiku", "sonnet", "opus"] as const;
const PATH = "launch.json providers.claude";

type AutoRunTask = (typeof AUTO_RUN_TASKS)[number];
type Model = (typeof MODELS)[number] | "inherit" | typeof BY_DIFFICULTY;
type Effort = EffortLevel | "inherit" | typeof BY_DIFFICULTY;
interface Profile { readonly model: Model; readonly effort: Effort; readonly deniedTools: readonly string[]; }

const INHERIT: Profile = { model: "inherit", effort: "inherit", deniedTools: [] };
const EXPLORE: Profile = { model: "haiku", effort: "low", deniedTools: [] };
const WORKER: Profile = { model: BY_DIFFICULTY, effort: BY_DIFFICULTY, deniedTools: [] };
const DEFAULT_DELEGATIONS: Readonly<Record<DelegationTask, Profile>> = {
  explore: EXPLORE, prototype: INHERIT, websearch: INHERIT, brainstorm: INHERIT,
  address: INHERIT, review: INHERIT, general: INHERIT,
};
const DEFAULT_AUTO_RUN: Readonly<Record<AutoRunTask, Profile>> = { explore: EXPLORE, address: WORKER, review: WORKER };

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LaunchFileError(`${path} must be a JSON object`);
  return value as Record<string, unknown>;
}

function command(value: unknown): readonly string[] {
  if (value === undefined) return ["claude"];
  if (!Array.isArray(value) || value.length === 0 || !value.every((token) => typeof token === "string" && token.trim().length > 0)) throw new LaunchFileError(`${PATH}.command must be a non-empty array of non-empty strings`);
  return value;
}

function profile(value: unknown, fallback: Profile, path: string, options: { readonly byDifficulty?: boolean; readonly deniedTools?: boolean } = {}): { readonly value: Profile; readonly unknown: readonly string[] } {
  const input = value === undefined ? {} : object(value, path);
  const modelAllowed = options.byDifficulty === true ? [BY_DIFFICULTY, ...MODELS] : ["inherit", ...MODELS];
  const effortAllowed = options.byDifficulty === true ? [BY_DIFFICULTY, ...EFFORT_LEVELS] : ["inherit", ...EFFORT_LEVELS];
  const selectedModel = input.model ?? fallback.model;
  const selectedEffort = input.effort ?? fallback.effort;
  if (typeof selectedModel !== "string" || !modelAllowed.includes(selectedModel as never)) throw new LaunchFileError(`${path}.model is not valid for platform claude; expected one of ${modelAllowed.join(", ")}`);
  if (typeof selectedEffort !== "string" || !effortAllowed.includes(selectedEffort as never)) throw new LaunchFileError(`${path}.effort is not valid for platform claude; expected one of ${effortAllowed.join(", ")}`);
  if (options.deniedTools === false && input.deniedTools !== undefined) throw new LaunchFileError(`${path}.deniedTools is not supported for platform claude`);
  const deniedTools = input.deniedTools ?? fallback.deniedTools;
  if (!Array.isArray(deniedTools) || !deniedTools.every((rule) => typeof rule === "string" && rule.trim().length > 0)) throw new LaunchFileError(`${path}.deniedTools must be an array of non-empty strings`);
  return { value: { model: selectedModel as Model, effort: selectedEffort as Effort, deniedTools: [...new Set(deniedTools)] }, unknown: Object.keys(input).filter((field) => !PROFILE_FIELDS.has(field)) };
}

function settings(commandValue: readonly string[], selected: Profile, shape: LaunchConfiguration["shape"], skillName?: string): LaunchConfiguration {
  return {
    shape,
    ...(shape === "builtin" ? { agentName: "Explore" } : {}),
    ...(shape === "skill" ? { skillName: skillName ?? "" } : {}),
    declaredCommand: commandValue,
    ...(selected.model === "inherit" ? {} : { declaredModel: selected.model }),
    ...(selected.effort === "inherit" ? {} : { declaredEffort: selected.effort as DeclaredEffort }),
    deniedTools: selected.deniedTools,
  } as LaunchConfiguration;
}

class ClaudeLaunchFile implements PlatformLaunchFile {
  public readonly platform = "claude" as const;
  public constructor(private readonly commandValue: readonly string[], private readonly interactive: Profile, private readonly delegations: Readonly<Record<DelegationTask, Profile>>, private readonly autoRun: Readonly<Record<AutoRunTask, Profile>>) {}
  public configuration(type: AgentType): ConfiguredLaunch {
    if (type === "interactive") return { platform: this.platform, settings: settings(this.commandValue, this.interactive, "default") };
    if (type === "explore") return { platform: this.platform, settings: settings(this.commandValue, this.autoRun.explore, "builtin") };
    if (type === "address" || type === "review") return { platform: this.platform, settings: settings(this.commandValue, this.autoRun[type], "skill", `${type}-this`) };
    return this.delegationConfiguration(type);
  }
  public delegationConfiguration(task: DelegationTask): ConfiguredLaunch {
    return { platform: this.platform, settings: settings(this.commandValue, this.delegations[task], task === "explore" ? "builtin" : "default") };
  }
}

export function parseClaudeLaunchFile(root: Record<string, unknown>): { readonly value: PlatformLaunchFile; readonly unknownFields: readonly string[] } {
  const unknown = Object.keys(root).filter((field) => !ROOT_FIELDS.has(field));
  const interactive = profile(root.interactive, INHERIT, `${PATH}.interactive`, { deniedTools: true });
  unknown.push(...interactive.unknown.map((field) => `interactive.${field}`));
  const delegationInput = root.delegations === undefined ? {} : object(root.delegations, `${PATH}.delegations`);
  unknown.push(...Object.keys(delegationInput).filter((field) => !DELEGATION_TASKS.includes(field as DelegationTask)).map((field) => `delegations.${field}`));
  const delegations = {} as Record<DelegationTask, Profile>;
  for (const task of DELEGATION_TASKS) {
    const parsed = profile(delegationInput[task], DEFAULT_DELEGATIONS[task], `${PATH}.delegations.${task}`, { deniedTools: task !== "explore" });
    delegations[task] = parsed.value;
    unknown.push(...parsed.unknown.map((field) => `delegations.${task}.${field}`));
  }
  const autoRunInput = root.autoRun === undefined ? {} : object(root.autoRun, `${PATH}.autoRun`);
  unknown.push(...Object.keys(autoRunInput).filter((field) => !AUTO_RUN_TASKS.includes(field as AutoRunTask)).map((field) => `autoRun.${field}`));
  const autoRun = {} as Record<AutoRunTask, Profile>;
  for (const task of AUTO_RUN_TASKS) {
    const parsed = profile(autoRunInput[task], DEFAULT_AUTO_RUN[task], `${PATH}.autoRun.${task}`, { byDifficulty: task !== "explore", deniedTools: task !== "explore" });
    autoRun[task] = parsed.value;
    unknown.push(...parsed.unknown.map((field) => `autoRun.${task}.${field}`));
  }
  return { value: new ClaudeLaunchFile(command(root.command), interactive.value, delegations, autoRun), unknownFields: unknown };
}
