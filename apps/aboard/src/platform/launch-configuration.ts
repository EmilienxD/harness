import { readFile } from "node:fs/promises";

import type { DelegationConfigurationSource } from "../bridge/delegation.js";
import { parseClaudeLaunchFile } from "../claude/launch-configuration.js";
import { parseChatGptLaunchFile } from "../chatgpt/launch-configuration.js";
import type { AgentType } from "../domain/contracts.js";
import type { AgentPlatformId, ConfiguredLaunch } from "./agent-platform.js";

export const DELEGATION_TASKS = ["explore", "prototype", "websearch", "brainstorm", "address", "review", "general"] as const;
export type DelegationTask = (typeof DELEGATION_TASKS)[number];

export interface LaunchFileDiagnostic { readonly severity: "warning"; readonly message: string; }
export class LaunchFileError extends Error {
  public constructor(message: string, public readonly cause?: unknown) { super(message); }
}

export interface PlatformLaunchFile {
  readonly platform: AgentPlatformId;
  configuration(type: AgentType): ConfiguredLaunch;
  delegationConfiguration(task: DelegationTask): ConfiguredLaunch;
}

export interface LaunchFile {
  readonly autoRunProvider: AgentPlatformId;
  configurationFor(platform: AgentPlatformId, type: AgentType): ConfiguredLaunch;
  delegationConfigurationFor(platform: AgentPlatformId, task: DelegationTask): ConfiguredLaunch;
}

export interface ParsedLaunchFile {
  readonly value: LaunchFile;
  readonly diagnostics: readonly LaunchFileDiagnostic[];
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LaunchFileError(`${path} must be a JSON object`);
  return value as Record<string, unknown>;
}

function providerSection(value: unknown, name: AgentPlatformId): Record<string, unknown> {
  if (value === undefined) return {};
  return object(value, `config.json providers.${name}`);
}

function platform(value: unknown, path: string): AgentPlatformId {
  if (value === undefined) throw new LaunchFileError(`${path} is required; set it to "claude" or "chatgpt"`);
  if (value !== "claude" && value !== "chatgpt") throw new LaunchFileError(`${path} must be "claude" or "chatgpt"; received ${JSON.stringify(value)}`);
  return value;
}

function sessionSettings(value: unknown): { readonly unknownFields: readonly string[] } {
  if (value === undefined) return { unknownFields: [] };
  const session = object(value, "config.json session");
  const stopWaitHours = session.stopWaitHours;
  if (stopWaitHours !== undefined && (typeof stopWaitHours !== "number" || !Number.isFinite(stopWaitHours) || stopWaitHours < 0)) {
    throw new LaunchFileError("config.json session.stopWaitHours must be a non-negative finite number");
  }
  return { unknownFields: Object.keys(session).filter((field) => field !== "stopWaitHours") };
}

class ConfiguredLaunchFile implements LaunchFile {
  public constructor(
    public readonly autoRunProvider: AgentPlatformId,
    private readonly providers: ReadonlyMap<AgentPlatformId, PlatformLaunchFile>,
  ) {}

  public configurationFor(platform: AgentPlatformId, type: AgentType): ConfiguredLaunch {
    const configured = this.providers.get(platform);
    if (configured === undefined) throw new LaunchFileError(`config.json has no configuration for provider ${platform}`);
    return configured.configuration(type);
  }
  public delegationConfigurationFor(platform: AgentPlatformId, task: DelegationTask): ConfiguredLaunch {
    const configured = this.providers.get(platform);
    if (configured === undefined) throw new LaunchFileError(`config.json has no configuration for provider ${platform}`);
    return configured.delegationConfiguration(task);
  }
}

export function parseLaunchFile(text: string): ParsedLaunchFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch (error) { throw new LaunchFileError(`config.json contains invalid JSON: ${error instanceof Error ? error.message : "parse error"}`); }
  const root = object(parsed, "config.json");
  if (root.version !== 1) {
    throw new LaunchFileError(
      `config.json version must be 1: {"version": 1}; received ${JSON.stringify(root.version)}`,
    );
  }
  const autoRun = root.autoRun === undefined ? {} : object(root.autoRun, "config.json autoRun");
  const autoRunProvider = root.autoRun === undefined || autoRun.provider === undefined ? "claude" : platform(autoRun.provider, "config.json autoRun.provider");
  const providerValues = root.providers === undefined ? {} : object(root.providers, "config.json providers");
  const session = sessionSettings(root.session);
  const claude = parseClaudeLaunchFile(providerSection(providerValues.claude, "claude"));
  const chatgpt = parseChatGptLaunchFile(providerSection(providerValues.chatgpt, "chatgpt"));
  const unknownFields = [
    // `grill` belongs to the grill-me-in-cloud hook, which shares this file.
    ...Object.keys(root).filter((field) => !["version", "autoRun", "providers", "session", "grill"].includes(field)),
    ...Object.keys(autoRun).filter((field) => field !== "provider").map((field) => `autoRun.${field}`),
    ...Object.keys(providerValues).filter((field) => field !== "claude" && field !== "chatgpt").map((field) => `providers.${field}`),
    ...session.unknownFields.map((field) => `session.${field}`),
    ...claude.unknownFields.map((field) => `providers.claude.${field}`),
    ...chatgpt.unknownFields.map((field) => `providers.chatgpt.${field}`),
  ];
  const value = new ConfiguredLaunchFile(autoRunProvider, new Map([
    ["claude", claude.value],
    ["chatgpt", chatgpt.value],
  ]));
  const diagnostics = unknownFields.length === 0
    ? []
    : [{ severity: "warning" as const, message: `config.json ignores unsupported fields: ${unknownFields.join(", ")}` }];
  return { value, diagnostics };
}

export async function readLaunchFile(path: string): Promise<ParsedLaunchFile> {
  try { return parseLaunchFile(await readFile(path, "utf8")); }
  catch (error) {
    if (error instanceof LaunchFileError) throw error;
    throw new LaunchFileError(`Unable to read config.json: ${error instanceof Error ? error.message : "unknown error"}`, error);
  }
}

function missing(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
  return error instanceof LaunchFileError && missing(error.cause);
}

export interface LaunchConfigurationPaths {
  readonly project: string;
  readonly global: string;
  readonly defaults?: string;
}

export function defaultLaunchFile(platform: AgentPlatformId = "claude"): ParsedLaunchFile {
  return parseLaunchFile(JSON.stringify(platform === "claude" ? { version: 1 } : { version: 1, autoRun: { provider: platform } }));
}

export class FileLaunchConfigurationSource implements DelegationConfigurationSource {
  readonly #paths: LaunchConfigurationPaths;

  public constructor(path: string | LaunchConfigurationPaths) {
    this.#paths = typeof path === "string"
      ? { project: path, global: `${path}.global-unconfigured` }
      : path;
  }

  public async load(): Promise<ParsedLaunchFile> {
    for (const path of [this.#paths.project, this.#paths.global]) {
      try { return await readLaunchFile(path); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return this.#paths.defaults === undefined ? defaultLaunchFile() : parseLaunchFile(this.#paths.defaults);
  }
  public async get(type: AgentType): Promise<ConfiguredLaunch> {
    const value = (await this.load()).value;
    return value.configurationFor(value.autoRunProvider, type);
  }

  public async getFor(platform: AgentPlatformId, type: AgentType): Promise<ConfiguredLaunch> {
    return (await this.load()).value.configurationFor(platform, type);
  }
  public async getDelegationFor(platform: AgentPlatformId, task: DelegationTask): Promise<ConfiguredLaunch> {
    return (await this.load()).value.delegationConfigurationFor(platform, task);
  }
}
