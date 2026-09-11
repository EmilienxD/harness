import { BY_DIFFICULTY } from "../claude/launch.js";
import { isAutoRunWorkerType, type AgentType } from "../domain/contracts.js";
import type { ConfiguredLaunch } from "../platform/agent-platform.js";
import { LaunchFileError, type PlatformLaunchFile } from "../platform/launch-configuration.js";
import { CHATGPT_EFFORTS, CHATGPT_WEB_SEARCH_MODES, type ChatGptEffort, type ChatGptLaunchConfiguration, type ChatGptWebSearch } from "./launch.js";

const PROFILE_NAMES = ["interactive", "explore", "implementer", "reviewer"] as const;
const ROOT_FIELDS = new Set(["version", "platform", "command", "stopWaitHours", ...PROFILE_NAMES]);
const PROFILE_FIELDS = new Set(["model", "effort", "webSearch", "subagents"]);
const WORKER_FIELDS = new Set(["webSearch", "subagents"]);
const CLAUDE_MODELS = new Set(["haiku", "sonnet", "opus"]);
const SUBAGENT_MODES = ["allowed", "denied"] as const;

type ProfileName = (typeof PROFILE_NAMES)[number];
type Model = string | typeof BY_DIFFICULTY;
type Effort = ChatGptEffort | typeof BY_DIFFICULTY;

interface Profile {
  readonly model?: Model;
  readonly effort?: Effort;
  readonly webSearch?: ChatGptWebSearch;
  readonly subagents?: (typeof SUBAGENT_MODES)[number];
}

const WORKER_DEFAULTS: Profile = { model: BY_DIFFICULTY, effort: BY_DIFFICULTY };

const DEFAULT_PROFILES: Readonly<Record<ProfileName, Profile>> = {
  interactive: {},
  explore: {},
  implementer: WORKER_DEFAULTS,
  reviewer: WORKER_DEFAULTS,
};

function isWorkerProfile(name: ProfileName): boolean {
  return name === "implementer" || name === "reviewer";
}

export function parseChatGptLaunchFile(root: Record<string, unknown>): { readonly value: PlatformLaunchFile; readonly unknownFields: readonly string[] } {
  const unknown = Object.keys(root).filter((field) => !ROOT_FIELDS.has(field));
  const command = parseCommand(root.command);
  const profiles = {} as Record<ProfileName, Profile>;
  for (const name of PROFILE_NAMES) {
    const input = root[name] === undefined ? {} : object(root[name], `launch.json ${name}`);
    unknown.push(...Object.keys(input).filter((field) => !PROFILE_FIELDS.has(field)).map((field) => `${name}.${field}`));
    for (const field of WORKER_FIELDS) {
      if (!isWorkerProfile(name) && input[field] !== undefined) throw new LaunchFileError(`launch.json ${name}.${field} is only supported for the implementer and reviewer profiles`);
    }
    const fallback = DEFAULT_PROFILES[name];
    profiles[name] = {
      ...optional("model", parseModel(input.model, name, fallback.model)),
      ...optional("effort", parseEffort(input.effort, name, fallback.effort)),
      ...optional("webSearch", parseChoice(input.webSearch, CHATGPT_WEB_SEARCH_MODES, name, "webSearch", fallback.webSearch)),
      ...optional("subagents", parseChoice(input.subagents, SUBAGENT_MODES, name, "subagents", fallback.subagents)),
    };
  }
  return { value: new ChatGptLaunchFile(command, profiles), unknownFields: unknown };
}

class ChatGptLaunchFile implements PlatformLaunchFile {
  public readonly platform = "chatgpt" as const;
  public constructor(private readonly command: readonly string[], private readonly profiles: Readonly<Record<ProfileName, Profile>>) {}
  public configuration(type: AgentType): ConfiguredLaunch {
    const profileName: ProfileName = type === "Explore" ? "explore"
      : type === "implementer" || type === "reviewer" ? type : "interactive";
    const profile = this.profiles[profileName];
    const common = {
      declaredCommand: this.command,
      ...(profile.model === undefined ? {} : { declaredModel: profile.model }),
      ...(profile.effort === undefined ? {} : { declaredEffort: profile.effort }),
    };
    const settings: ChatGptLaunchConfiguration = isAutoRunWorkerType(type)
      ? {
          shape: "skill",
          skillName: type === "implementer" ? "adress-this" : "review-this",
          ...common,
          ...(profile.webSearch === undefined ? {} : { webSearch: profile.webSearch }),
          ...(profile.subagents === undefined ? {} : { subagents: profile.subagents }),
        }
      : { shape: type === "Explore" ? "explore" : "default", ...common };
    return { platform: this.platform, settings };
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LaunchFileError(`${path} must be a JSON object`);
  return value as Record<string, unknown>;
}

function parseCommand(value: unknown): readonly string[] {
  if (value === undefined) return ["codex"];
  if (!Array.isArray(value) || value.length === 0 || !value.every((token) => typeof token === "string" && token.trim().length > 0)) throw new LaunchFileError("launch.json command must be a non-empty array of non-empty strings");
  return value;
}

function parseModel(value: unknown, profile: ProfileName, fallback: Model | undefined): Model | undefined {
  if (value === undefined) return fallback;
  if (value === "inherit") return undefined;
  if (value === BY_DIFFICULTY) {
    if (!isWorkerProfile(profile)) throw new LaunchFileError(`launch.json ${profile}.model must be inherit or a Codex model slug`);
    return BY_DIFFICULTY;
  }
  if (typeof value !== "string" || value.trim().length === 0) throw new LaunchFileError(`launch.json ${profile}.model must be inherit${isWorkerProfile(profile) ? `, ${BY_DIFFICULTY},` : ""} or a non-empty string`);
  if (CLAUDE_MODELS.has(value)) throw new LaunchFileError(`launch.json ${profile}.model is not valid for platform chatgpt; received Claude model ${JSON.stringify(value)}`);
  return value;
}

function parseEffort(value: unknown, profile: ProfileName, fallback: Effort | undefined): Effort | undefined {
  if (value === undefined) return fallback;
  if (value === "inherit") return undefined;
  const allowed = isWorkerProfile(profile) ? [BY_DIFFICULTY, ...CHATGPT_EFFORTS] : [...CHATGPT_EFFORTS];
  if (typeof value !== "string" || !allowed.includes(value)) throw new LaunchFileError(`launch.json ${profile}.effort is not valid for platform chatgpt; expected inherit or ${allowed.join(", ")}`);
  return value as Effort;
}

function parseChoice<T extends string>(value: unknown, allowed: readonly T[], profile: ProfileName, field: string, fallback: T | undefined): T | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new LaunchFileError(`launch.json ${profile}.${field} is not valid for platform chatgpt; expected ${allowed.join(", ")}`);
  return value as T;
}
