import type { AgentType } from "../domain/contracts.js";
import type { ConfiguredLaunch } from "../platform/agent-platform.js";
import { LaunchFileError, type PlatformLaunchFile } from "../platform/launch-configuration.js";
import { BY_DIFFICULTY, EFFORT_LEVELS, type DeclaredEffort, type EffortLevel } from "../platform/launch.js";
import type { LaunchConfiguration } from "./launch.js";

const PROFILE_NAMES = ["interactive", "explore", "implementer", "reviewer"] as const;
const ROOT_FIELDS = new Set(["command", ...PROFILE_NAMES]);
const PROFILE_FIELDS = new Set(["model", "effort", "deniedTools"]);
const MODELS = ["haiku", "sonnet", "opus"] as const;
/** Both providers are configured side by side, so every message names its own. */
const PATH = "launch.json providers.claude";

type ProfileName = (typeof PROFILE_NAMES)[number];
type Model = (typeof MODELS)[number] | "inherit" | typeof BY_DIFFICULTY;
type Effort = EffortLevel | "inherit" | typeof BY_DIFFICULTY;
interface Profile { readonly model: Model; readonly effort: Effort; readonly deniedTools: readonly string[]; }

const DEFAULT_PROFILES: Readonly<Record<ProfileName, Profile>> = {
  interactive: { model: "inherit", effort: "inherit", deniedTools: [] },
  explore: { model: "haiku", effort: "low", deniedTools: [] },
  implementer: { model: BY_DIFFICULTY, effort: BY_DIFFICULTY, deniedTools: [] },
  reviewer: { model: BY_DIFFICULTY, effort: BY_DIFFICULTY, deniedTools: [] },
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LaunchFileError(`${path} must be a JSON object`);
  return value as Record<string, unknown>;
}

function command(value: unknown): readonly string[] {
  if (value === undefined) return ["claude"];
  if (!Array.isArray(value) || value.length === 0 || !value.every((token) => typeof token === "string" && token.trim().length > 0)) throw new LaunchFileError(`${PATH}.command must be a non-empty array of non-empty strings`);
  return value;
}

function model(value: unknown, fallback: Model, profile: ProfileName): Model {
  if (value === undefined) return fallback;
  const allowed = profile === "interactive" || profile === "explore" ? ["inherit", ...MODELS] : [BY_DIFFICULTY, ...MODELS];
  if (typeof value !== "string" || !allowed.includes(value as never)) throw new LaunchFileError(`${PATH}.${profile}.model is not valid for platform claude; expected one of ${allowed.join(", ")}`);
  return value as Model;
}

function effort(value: unknown, fallback: Effort, profile: ProfileName): Effort {
  if (value === undefined) return fallback;
  const allowed = profile === "interactive" || profile === "explore" ? ["inherit", ...EFFORT_LEVELS] : [BY_DIFFICULTY, ...EFFORT_LEVELS];
  if (typeof value !== "string" || !allowed.includes(value as never)) throw new LaunchFileError(`${PATH}.${profile}.effort is not valid for platform claude; expected one of ${allowed.join(", ")}`);
  return value as Effort;
}

function deniedTools(value: unknown, fallback: readonly string[], profile: ProfileName): readonly string[] {
  if (profile === "explore" && value !== undefined) throw new LaunchFileError(`${PATH}.explore.deniedTools is not supported for platform claude`);
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((rule) => typeof rule === "string" && rule.trim().length > 0)) throw new LaunchFileError(`${PATH}.${profile}.deniedTools must be an array of non-empty strings`);
  return [...new Set(value)];
}

class ClaudeLaunchFile implements PlatformLaunchFile {
  public readonly platform = "claude" as const;
  public constructor(private readonly command: readonly string[], private readonly profiles: Readonly<Record<ProfileName, Profile>>) {}

  public configuration(type: AgentType): ConfiguredLaunch {
    const profileName: ProfileName = type === "Explore" ? "explore"
      : type === "implementer" || type === "reviewer" ? type : "interactive";
    const profile = this.profiles[profileName];
    const common = {
      declaredCommand: this.command,
      ...(profile.model === "inherit" ? {} : { declaredModel: profile.model }),
      ...(profile.effort === "inherit" ? {} : { declaredEffort: profile.effort as DeclaredEffort }),
      deniedTools: profile.deniedTools,
    };
    let settings: LaunchConfiguration;
    if (["interactive", "Prototype", "Web Search", "Brainstorm", "General"].includes(type)) settings = { shape: "default", ...common };
    else if (type === "Explore") settings = { shape: "builtin", agentName: "Explore", ...common };
    else if (type === "implementer") settings = { shape: "skill", skillName: "address-this", ...common };
    // AFK and HITL are auto-run orchestration modes, not separate review skills.
    else settings = { shape: "skill", skillName: "review-this", ...common };
    return { platform: this.platform, settings };
  }
}

export function parseClaudeLaunchFile(root: Record<string, unknown>): { readonly value: PlatformLaunchFile; readonly unknownFields: readonly string[] } {
  const unknown = Object.keys(root).filter((field) => !ROOT_FIELDS.has(field));
  const profiles = {} as Record<ProfileName, Profile>;
  for (const name of PROFILE_NAMES) {
    const input = root[name] === undefined ? {} : object(root[name], `${PATH}.${name}`);
    unknown.push(...Object.keys(input).filter((field) => !PROFILE_FIELDS.has(field)).map((field) => `${name}.${field}`));
    const fallback = DEFAULT_PROFILES[name];
    profiles[name] = { model: model(input.model, fallback.model, name), effort: effort(input.effort, fallback.effort, name), deniedTools: deniedTools(input.deniedTools, fallback.deniedTools, name) };
  }
  return { value: new ClaudeLaunchFile(command(root.command), profiles), unknownFields: unknown };
}
