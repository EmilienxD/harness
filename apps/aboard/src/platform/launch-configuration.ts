import { readFile } from "node:fs/promises";

import type { DelegationConfigurationSource } from "../bridge/delegation.js";
import { parseClaudeLaunchFile } from "../claude/launch-configuration.js";
import { parseChatGptLaunchFile } from "../chatgpt/launch-configuration.js";
import type { AgentType } from "../domain/contracts.js";
import type { AgentPlatformId, AutoRunReviewMode, ConfiguredLaunch } from "./agent-platform.js";

export interface LaunchFileDiagnostic { readonly severity: "warning"; readonly message: string; }
export class LaunchFileError extends Error {}

export interface PlatformLaunchFile {
  readonly platform: AgentPlatformId;
  configuration(type: AgentType, reviewMode?: AutoRunReviewMode): ConfiguredLaunch;
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
  if (root.version !== 1) throw new LaunchFileError("launch.json version must be 1");
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
    throw new LaunchFileError(`Unable to read launch.json: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export class FileLaunchConfigurationSource implements DelegationConfigurationSource {
  public constructor(private readonly path: string) {}
  public async load(): Promise<ParsedLaunchFile> { return readLaunchFile(this.path); }
  public async get(type: AgentType, reviewMode?: AutoRunReviewMode): Promise<ConfiguredLaunch> { return (await this.load()).value.configuration(type, reviewMode); }
}
