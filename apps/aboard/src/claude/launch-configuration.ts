import { readFile } from "node:fs/promises";

import type { DelegationConfigurationSource } from "../bridge/delegation.js";
import type { AgentType } from "../domain/contracts.js";
import {
  BY_DIFFICULTY,
  EFFORT_LEVELS,
  type AutoRunReviewMode,
  type DeclaredEffort,
  type EffortLevel,
  type LaunchConfiguration,
} from "./launch.js";

const PROFILE_NAMES = ["interactive", "explore", "implementer", "reviewer"] as const;
const ROOT_FIELDS = new Set(["version", "command", ...PROFILE_NAMES]);
const PROFILE_FIELDS = new Set(["model", "effort", "deniedTools"]);
const MODELS = ["haiku", "sonnet", "opus"] as const;
const DEFAULT_DENIED_TOOLS = ["Agent", "WebSearch", "WebFetch"] as const;

type ProfileName = (typeof PROFILE_NAMES)[number];
type Model = (typeof MODELS)[number] | "inherit" | typeof BY_DIFFICULTY;
type Effort = EffortLevel | "inherit" | typeof BY_DIFFICULTY;

interface Profile {
  readonly model: Model;
  readonly effort: Effort;
  readonly deniedTools: readonly string[];
}

export interface LaunchFileDiagnostic {
  readonly severity: "warning";
  readonly message: string;
}

export class LaunchFileError extends Error {}

export interface ParsedLaunchFile {
  readonly value: LaunchFile;
  readonly diagnostics: readonly LaunchFileDiagnostic[];
}

export class LaunchFile {
  public constructor(
    private readonly command: readonly string[],
    private readonly profiles: Readonly<Record<ProfileName, Profile>>,
  ) {}

  public configuration(type: AgentType, reviewMode: AutoRunReviewMode = "afk"): LaunchConfiguration {
    const profileName = type === "Explore" ? "explore" : type;
    const profile = this.profiles[profileName];
    const common = {
      declaredCommand: this.command,
      ...(profile.model === "inherit" ? {} : { declaredModel: profile.model }),
      ...(profile.effort === "inherit" ? {} : { declaredEffort: profile.effort as DeclaredEffort }),
      deniedTools: profile.deniedTools,
    };
    if (type === "interactive") return { shape: "default", ...common };
    if (type === "Explore") return { shape: "builtin", agentName: "Explore", ...common };
    if (type === "implementer") return { shape: "skill", skillName: "implement", ...common };
    return { shape: "skill", skillName: `review-${reviewMode}`, ...common };
  }
}

const DEFAULT_PROFILES: Readonly<Record<ProfileName, Profile>> = {
  interactive: { model: "inherit", effort: "inherit", deniedTools: DEFAULT_DENIED_TOOLS },
  explore: { model: "haiku", effort: "low", deniedTools: [] },
  implementer: { model: BY_DIFFICULTY, effort: BY_DIFFICULTY, deniedTools: DEFAULT_DENIED_TOOLS },
  reviewer: { model: BY_DIFFICULTY, effort: BY_DIFFICULTY, deniedTools: DEFAULT_DENIED_TOOLS },
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LaunchFileError(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function command(value: unknown): readonly string[] {
  if (value === undefined) return ["claude"];
  if (!Array.isArray(value) || value.length === 0 || !value.every((token) => typeof token === "string" && token.trim().length > 0)) {
    throw new LaunchFileError("launch.json command must be a non-empty array of non-empty strings");
  }
  return value;
}

function model(value: unknown, fallback: Model, profile: ProfileName): Model {
  if (value === undefined) return fallback;
  const allowed = profile === "interactive" || profile === "explore"
    ? ["inherit", ...MODELS]
    : [BY_DIFFICULTY, ...MODELS];
  if (typeof value !== "string" || !allowed.includes(value as never)) {
    throw new LaunchFileError(`launch.json ${profile}.model must be one of ${allowed.join(", ")}`);
  }
  return value as Model;
}

function effort(value: unknown, fallback: Effort, profile: ProfileName): Effort {
  if (value === undefined) return fallback;
  const allowed = profile === "interactive" || profile === "explore"
    ? ["inherit", ...EFFORT_LEVELS]
    : [BY_DIFFICULTY, ...EFFORT_LEVELS];
  if (typeof value !== "string" || !allowed.includes(value as never)) {
    throw new LaunchFileError(`launch.json ${profile}.effort must be one of ${allowed.join(", ")}`);
  }
  return value as Effort;
}

function deniedTools(value: unknown, fallback: readonly string[], profile: ProfileName): readonly string[] {
  if (profile === "explore" && value !== undefined) {
    throw new LaunchFileError("launch.json explore.deniedTools is not supported");
  }
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((rule) => typeof rule === "string" && rule.trim().length > 0)) {
    throw new LaunchFileError(`launch.json ${profile}.deniedTools must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

export function parseLaunchFile(text: string): ParsedLaunchFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new LaunchFileError(`launch.json contains invalid JSON: ${error instanceof Error ? error.message : "parse error"}`);
  }
  const root = object(parsed, "launch.json");
  if (root.version !== 1) throw new LaunchFileError("launch.json version must be 1");
  const unknown = Object.keys(root).filter((field) => !ROOT_FIELDS.has(field));
  const profiles = {} as Record<ProfileName, Profile>;
  for (const name of PROFILE_NAMES) {
    const input = root[name] === undefined ? {} : object(root[name], `launch.json ${name}`);
    unknown.push(...Object.keys(input).filter((field) => !PROFILE_FIELDS.has(field)).map((field) => `${name}.${field}`));
    const fallback = DEFAULT_PROFILES[name];
    profiles[name] = {
      model: model(input.model, fallback.model, name),
      effort: effort(input.effort, fallback.effort, name),
      deniedTools: deniedTools(input.deniedTools, fallback.deniedTools, name),
    };
  }
  const diagnostics = unknown.length === 0
    ? []
    : [{ severity: "warning" as const, message: `launch.json ignores unsupported fields: ${unknown.join(", ")}` }];
  return { value: new LaunchFile(command(root.command), profiles), diagnostics };
}

export async function readLaunchFile(path: string): Promise<ParsedLaunchFile> {
  try {
    return parseLaunchFile(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof LaunchFileError) throw error;
    throw new LaunchFileError(`Unable to read launch.json: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export class FileLaunchConfigurationSource implements DelegationConfigurationSource {
  public constructor(private readonly path: string) {}

  public async load(): Promise<ParsedLaunchFile> {
    return readLaunchFile(this.path);
  }

  public async get(type: AgentType, reviewMode?: AutoRunReviewMode): Promise<LaunchConfiguration> {
    const parsed = await this.load();
    return parsed.value.configuration(type, reviewMode);
  }
}
