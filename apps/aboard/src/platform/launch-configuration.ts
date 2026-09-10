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

export interface ParsedLaunchFile {
  readonly value: PlatformLaunchFile;
  readonly diagnostics: readonly LaunchFileDiagnostic[];
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LaunchFileError(`${path} must be a JSON object`);
  return value as Record<string, unknown>;
}

function platform(value: unknown): AgentPlatformId {
  if (value === undefined) throw new LaunchFileError('launch.json platform is required; set it to "claude" or "chatgpt"');
  if (value !== "claude" && value !== "chatgpt") throw new LaunchFileError(`launch.json platform must be "claude" or "chatgpt"; received ${JSON.stringify(value)}`);
  return value;
}

export function parseLaunchFile(text: string): ParsedLaunchFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch (error) { throw new LaunchFileError(`launch.json contains invalid JSON: ${error instanceof Error ? error.message : "parse error"}`); }
  const root = object(parsed, "launch.json");
  if (root.version !== 2) throw new LaunchFileError("launch.json version must be 2");
  if (root.stopWaitHours !== undefined && (
    typeof root.stopWaitHours !== "number" || !Number.isFinite(root.stopWaitHours) || root.stopWaitHours < 0
  )) throw new LaunchFileError("launch.json stopWaitHours must be a non-negative finite number");
  const selectedPlatform = platform(root.platform);
  const parsedPlatform = (() => {
    switch (selectedPlatform) {
      case "claude": return parseClaudeLaunchFile(root);
      case "chatgpt": return parseChatGptLaunchFile(root);
    }
  })();
  const diagnostics = parsedPlatform.unknownFields.length === 0
    ? []
    : [{ severity: "warning" as const, message: `launch.json ignores unsupported fields: ${parsedPlatform.unknownFields.join(", ")}` }];
  return { value: parsedPlatform.value, diagnostics };
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
  return parseLaunchFile(JSON.stringify({ version: 2, platform }));
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
  public async get(type: AgentType): Promise<ConfiguredLaunch> { return (await this.load()).value.configuration(type); }

  public async getFor(platform: AgentPlatformId, type: AgentType): Promise<ConfiguredLaunch> {
    const selected = await this.load();
    return (selected.value.platform === platform ? selected : defaultLaunchFile(platform)).value.configuration(type);
  }
}
