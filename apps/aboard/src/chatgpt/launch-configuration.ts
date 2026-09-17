import type { AgentType } from "../domain/contracts.js";
import type { ConfiguredLaunch } from "../platform/agent-platform.js";
import { DELEGATION_TASKS, LaunchFileError, type DelegationTask, type PlatformLaunchFile } from "../platform/launch-configuration.js";
import { BY_DIFFICULTY } from "../platform/launch.js";
import { CHATGPT_EFFORTS, CHATGPT_WEB_SEARCH_MODES, type ChatGptEffort, type ChatGptLaunchConfiguration, type ChatGptWebSearch } from "./launch.js";

const AUTO_RUN_TASKS = ["explore", "address", "review"] as const;
const ROOT_FIELDS = new Set(["command", "interactive", "delegations", "autoRun"]);
const PROFILE_FIELDS = new Set(["model", "effort", "webSearch", "subagents"]);
const CLAUDE_MODELS = new Set(["haiku", "sonnet", "opus"]);
const SUBAGENT_MODES = ["allowed", "denied"] as const;
const PATH = "launch.json providers.chatgpt";

type AutoRunTask = (typeof AUTO_RUN_TASKS)[number];
interface Profile { readonly model?: string; readonly effort?: ChatGptEffort | typeof BY_DIFFICULTY; readonly webSearch?: ChatGptWebSearch; readonly subagents?: (typeof SUBAGENT_MODES)[number]; }
const INHERIT: Profile = {};
const EXPLORE: Profile = { model: "gpt-5.6-luna", effort: "low" };
const WORKER: Profile = { model: BY_DIFFICULTY, effort: BY_DIFFICULTY };
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
  if (value === undefined) return ["codex"];
  if (!Array.isArray(value) || value.length === 0 || !value.every((token) => typeof token === "string" && token.trim().length > 0)) throw new LaunchFileError(`${PATH}.command must be a non-empty array of non-empty strings`);
  return value;
}
function profile(value: unknown, fallback: Profile, path: string, worker = false): { readonly value: Profile; readonly unknown: readonly string[] } {
  const input = value === undefined ? {} : object(value, path);
  const rawModel = input.model;
  const selectedModel = rawModel === undefined ? fallback.model : rawModel === "inherit" ? undefined : rawModel;
  if (selectedModel !== undefined && (typeof selectedModel !== "string" || selectedModel.trim().length === 0 || CLAUDE_MODELS.has(selectedModel) || (selectedModel === BY_DIFFICULTY && !worker))) throw new LaunchFileError(`${path}.model is not valid for platform chatgpt; expected inherit${worker ? `, ${BY_DIFFICULTY},` : ""} or a Codex model slug`);
  const rawEffort = input.effort;
  const selectedEffort = rawEffort === undefined ? fallback.effort : rawEffort === "inherit" ? undefined : rawEffort;
  const efforts = worker ? [BY_DIFFICULTY, ...CHATGPT_EFFORTS] : CHATGPT_EFFORTS;
  if (selectedEffort !== undefined && (typeof selectedEffort !== "string" || !efforts.includes(selectedEffort as never))) throw new LaunchFileError(`${path}.effort is not valid for platform chatgpt; expected inherit or ${efforts.join(", ")}`);
  if (!worker && (input.webSearch !== undefined || input.subagents !== undefined)) throw new LaunchFileError(`${path}.${input.webSearch !== undefined ? "webSearch" : "subagents"} is only supported for Auto Run address and review profiles`);
  const webSearch = input.webSearch ?? fallback.webSearch;
  const subagents = input.subagents ?? fallback.subagents;
  if (webSearch !== undefined && (typeof webSearch !== "string" || !CHATGPT_WEB_SEARCH_MODES.includes(webSearch as ChatGptWebSearch))) throw new LaunchFileError(`${path}.webSearch is not valid for platform chatgpt; expected ${CHATGPT_WEB_SEARCH_MODES.join(", ")}`);
  if (subagents !== undefined && (typeof subagents !== "string" || !SUBAGENT_MODES.includes(subagents as never))) throw new LaunchFileError(`${path}.subagents is not valid for platform chatgpt; expected ${SUBAGENT_MODES.join(", ")}`);
  return {
    value: {
      ...(selectedModel === undefined ? {} : { model: selectedModel }),
      ...(selectedEffort === undefined ? {} : { effort: selectedEffort as NonNullable<Profile["effort"]> }),
      ...(webSearch === undefined ? {} : { webSearch: webSearch as ChatGptWebSearch }),
      ...(subagents === undefined ? {} : { subagents: subagents as NonNullable<Profile["subagents"]> }),
    },
    unknown: Object.keys(input).filter((field) => !PROFILE_FIELDS.has(field)),
  };
}
function settings(commandValue: readonly string[], selected: Profile, shape: ChatGptLaunchConfiguration["shape"], skillName?: string): ChatGptLaunchConfiguration {
  return {
    shape,
    ...(shape === "skill" ? { skillName: skillName ?? "" } : {}),
    declaredCommand: commandValue,
    ...(selected.model === undefined ? {} : { declaredModel: selected.model }),
    ...(selected.effort === undefined ? {} : { declaredEffort: selected.effort }),
    ...(selected.webSearch === undefined ? {} : { webSearch: selected.webSearch }),
    ...(selected.subagents === undefined ? {} : { subagents: selected.subagents }),
  };
}
class ChatGptLaunchFile implements PlatformLaunchFile {
  public readonly platform = "chatgpt" as const;
  public constructor(private readonly commandValue: readonly string[], private readonly interactive: Profile, private readonly delegations: Readonly<Record<DelegationTask, Profile>>, private readonly autoRun: Readonly<Record<AutoRunTask, Profile>>) {}
  public configuration(type: AgentType): ConfiguredLaunch {
    if (type === "interactive") return { platform: this.platform, settings: settings(this.commandValue, this.interactive, "default") };
    if (type === "explore") return { platform: this.platform, settings: settings(this.commandValue, this.autoRun.explore, "explore") };
    if (type === "address" || type === "review") return { platform: this.platform, settings: settings(this.commandValue, this.autoRun[type], "skill", `${type}-this`) };
    return this.delegationConfiguration(type);
  }
  public delegationConfiguration(task: DelegationTask): ConfiguredLaunch {
    return { platform: this.platform, settings: settings(this.commandValue, this.delegations[task], task === "explore" ? "explore" : "default") };
  }
}
export function parseChatGptLaunchFile(root: Record<string, unknown>): { readonly value: PlatformLaunchFile; readonly unknownFields: readonly string[] } {
  const unknown = Object.keys(root).filter((field) => !ROOT_FIELDS.has(field));
  const interactive = profile(root.interactive, INHERIT, `${PATH}.interactive`);
  unknown.push(...interactive.unknown.map((field) => `interactive.${field}`));
  const delegationInput = root.delegations === undefined ? {} : object(root.delegations, `${PATH}.delegations`);
  unknown.push(...Object.keys(delegationInput).filter((field) => !DELEGATION_TASKS.includes(field as DelegationTask)).map((field) => `delegations.${field}`));
  const delegations = {} as Record<DelegationTask, Profile>;
  for (const task of DELEGATION_TASKS) {
    const parsed = profile(delegationInput[task], DEFAULT_DELEGATIONS[task], `${PATH}.delegations.${task}`);
    delegations[task] = parsed.value;
    unknown.push(...parsed.unknown.map((field) => `delegations.${task}.${field}`));
  }
  const autoRunInput = root.autoRun === undefined ? {} : object(root.autoRun, `${PATH}.autoRun`);
  unknown.push(...Object.keys(autoRunInput).filter((field) => !AUTO_RUN_TASKS.includes(field as AutoRunTask)).map((field) => `autoRun.${field}`));
  const autoRun = {} as Record<AutoRunTask, Profile>;
  for (const task of AUTO_RUN_TASKS) {
    const parsed = profile(autoRunInput[task], DEFAULT_AUTO_RUN[task], `${PATH}.autoRun.${task}`, task !== "explore");
    autoRun[task] = parsed.value;
    unknown.push(...parsed.unknown.map((field) => `autoRun.${task}.${field}`));
  }
  return { value: new ChatGptLaunchFile(command(root.command), interactive.value, delegations, autoRun), unknownFields: unknown };
}
