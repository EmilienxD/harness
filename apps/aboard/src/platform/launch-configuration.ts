import { readFile } from "node:fs/promises";

import type { DelegationConfigurationSource } from "../bridge/delegation.js";
import { parseClaudeLaunchFile } from "../claude/launch-configuration.js";
import { parseChatGptLaunchFile } from "../chatgpt/launch-configuration.js";
import type { AgentType } from "../domain/contracts.js";
import type { AgentPlatformId, ConfiguredLaunch } from "./agent-platform.js";

export interface LaunchFileDiagnostic { readonly severity: "warning"; readonly message: string; }
export class LaunchFileError extends Error {
  public constructor(message: string, public readonly cause?: unknown) { super(message); }
}

export interface PlatformLaunchFile {
  readonly platform: AgentPlatformId;
  configuration(type: AgentType): ConfiguredLaunch;
}

export interface LaunchFile {
  readonly autoRunProvider: AgentPlatformId;
  configurationFor(platform: AgentPlatformId, type: AgentType): ConfiguredLaunch;
}

export interface ParsedLaunchFile {
  readonly value: LaunchFile;
  readonly diagnostics: readonly LaunchFileDiagnostic[];
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LaunchFileError(`${path} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** Both providers are configured independently, so neither may be left out. */
function providerSection(value: unknown, name: AgentPlatformId): Record<string, unknown> {
  if (value === undefined) throw new LaunchFileError(`launch.json providers.${name} is required; configure every provider, using {} to accept its defaults`);
  return object(value, `launch.json providers.${name}`);
}

function platform(value: unknown, path: string): AgentPlatformId {
  if (value === undefined) throw new LaunchFileError(`${path} is required; set it to "claude" or "chatgpt"`);
  if (value !== "claude" && value !== "chatgpt") throw new LaunchFileError(`${path} must be "claude" or "chatgpt"; received ${JSON.stringify(value)}`);
  return value;
}

function sessionSettings(value: unknown): { readonly unknownFields: readonly string[] } {
  if (value === undefined) return { unknownFields: [] };
  const session = object(value, "launch.json session");
  const stopWaitHours = session.stopWaitHours;
  if (stopWaitHours !== undefined && (typeof stopWaitHours !== "number" || !Number.isFinite(stopWaitHours) || stopWaitHours < 0)) {
    throw new LaunchFileError("launch.json session.stopWaitHours must be a non-negative finite number");
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
    if (configured === undefined) throw new LaunchFileError(`launch.json has no configuration for provider ${platform}`);
    return configured.configuration(type);
  }
}

export function parseLaunchFile(text: string): ParsedLaunchFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch (error) { throw new LaunchFileError(`launch.json contains invalid JSON: ${error instanceof Error ? error.message : "parse error"}`); }
  const root = object(parsed, "launch.json");
  if (root.version !== 1) {
    throw new LaunchFileError(
      `launch.json version must be 1: {"version": 1, "autoRun": {"provider": "claude"}, "providers": {"claude": {}, "chatgpt": {}}}; received ${JSON.stringify(root.version)}`,
    );
  }
  const autoRun = object(root.autoRun, "launch.json autoRun");
  const autoRunProvider = platform(autoRun.provider, "launch.json autoRun.provider");
  const providerValues = object(root.providers, "launch.json providers");
  const session = sessionSettings(root.session);
  const claude = parseClaudeLaunchFile(providerSection(providerValues.claude, "claude"));
  const chatgpt = parseChatGptLaunchFile(providerSection(providerValues.chatgpt, "chatgpt"));
  const unknownFields = [
    ...Object.keys(root).filter((field) => !["version", "autoRun", "providers", "session"].includes(field)),
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
    : [{ severity: "warning" as const, message: `launch.json ignores unsupported fields: ${unknownFields.join(", ")}` }];
  return { value, diagnostics };
}

export async function readLaunchFile(path: string): Promise<ParsedLaunchFile> {
  try { return parseLaunchFile(await readFile(path, "utf8")); }
  catch (error) {
    if (error instanceof LaunchFileError) throw error;
    throw new LaunchFileError(`Unable to read launch.json: ${error instanceof Error ? error.message : "unknown error"}`, error);
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
  return parseLaunchFile(JSON.stringify({ version: 1, autoRun: { provider: platform }, providers: { claude: {}, chatgpt: {} } }));
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
}
