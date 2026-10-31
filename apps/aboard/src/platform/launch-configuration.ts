import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProcessGitClient } from "../git/client.js";

import type { DelegationConfigurationSource } from "../bridge/delegation.js";
import { parseClaudeLaunchFile } from "../claude/launch-configuration.js";
import { parseChatGptLaunchFile } from "../chatgpt/launch-configuration.js";
import { parsePiLaunchFile } from "../pi/launch-configuration.js";
import { AGENT_PLATFORM_IDS } from "../domain/contracts.js";
import type { AgentType } from "../domain/contracts.js";
import type { AgentPlatformId, ConfiguredLaunch } from "./agent-platform.js";

export const DELEGATION_TASKS = ["explore", "prototype", "websearch", "brainstorm", "address", "review", "general", "loop"] as const;
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
  if (typeof value !== "string" || !AGENT_PLATFORM_IDS.includes(value as AgentPlatformId)) throw new LaunchFileError(`${path} must be one of ${AGENT_PLATFORM_IDS.join(", ")}; received ${JSON.stringify(value)}`);
  return value as AgentPlatformId;
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

function loopSettings(value: unknown): { readonly unknownFields: readonly string[] } {
  if (value === undefined) return { unknownFields: [] };
  const loop = object(value, "config.json loop");
  for (const key of ["maxFeedback", "maxImplementers", "freshContextPercent"] as const) {
    const selected = loop[key];
    if (selected === undefined) continue;
    const valid = typeof selected === "number" && Number.isFinite(selected) && (
      key === "freshContextPercent" ? selected >= 0 && selected <= 100
        : Number.isInteger(selected) && selected >= (key === "maxImplementers" ? 1 : 0)
    );
    if (!valid) throw new LaunchFileError(`config.json loop.${key} is invalid`);
  }
  return { unknownFields: Object.keys(loop).filter((key) => !["maxFeedback", "maxImplementers", "freshContextPercent"].includes(key)) };
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

interface LaunchSelection { readonly platform?: AgentPlatformId; readonly type?: AgentType; readonly task?: DelegationTask; }

function selectedSection(values: Record<string, unknown>, provider: AgentPlatformId, selection?: LaunchSelection): Record<string, unknown> {
  if (!selection) return providerSection(values[provider], provider);
  if (selection.platform !== provider) return {};
  const section = providerSection(values[provider], provider);
  const selected: Record<string, unknown> = { command: section.command };
  if (selection.task) selected.delegations = { [selection.task]: object(section.delegations ?? {}, `providers.${provider}.delegations`)[selection.task] };
  else if (selection.type === "interactive") selected.interactive = section.interactive;
  else {
    const group = ["explore", "address", "review"].includes(selection.type!) ? "autoRun" : "delegations";
    selected[group] = { [selection.type!]: object(section[group] ?? {}, `providers.${provider}.${group}`)[selection.type!] };
  }
  return selected;
}

export function parseLaunchFile(text: string, selection?: LaunchSelection): ParsedLaunchFile {
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
  if (selection && selection.platform === undefined) selection = { ...selection, platform: autoRunProvider };
  const providerValues = root.providers === undefined ? {} : object(root.providers, "config.json providers");
  const session = sessionSettings(selection ? undefined : root.session);
  const loop = loopSettings(selection ? undefined : root.loop);
  const claude = parseClaudeLaunchFile(selectedSection(providerValues, "claude", selection));
  const chatgpt = parseChatGptLaunchFile(selectedSection(providerValues, "chatgpt", selection));
  const pi = parsePiLaunchFile(selectedSection(providerValues, "pi", selection));
  const unknownFields = [
    // `grill` belongs to the grill-me-in-cloud hook, which shares this file.
    ...Object.keys(root).filter((field) => !["version", "autoRun", "providers", "session", "loop", "grill"].includes(field)),
    ...Object.keys(autoRun).filter((field) => field !== "provider").map((field) => `autoRun.${field}`),
    ...Object.keys(providerValues).filter((field) => !AGENT_PLATFORM_IDS.includes(field as AgentPlatformId)).map((field) => `providers.${field}`),
    ...session.unknownFields.map((field) => `session.${field}`),
    ...loop.unknownFields.map((field) => `loop.${field}`),
    ...claude.unknownFields.map((field) => `providers.claude.${field}`),
    ...chatgpt.unknownFields.map((field) => `providers.chatgpt.${field}`),
    ...pi.unknownFields.map((field) => `providers.pi.${field}`),
  ];
  const value = new ConfiguredLaunchFile(autoRunProvider, new Map([
    ["claude", claude.value],
    ["chatgpt", chatgpt.value],
    ["pi", pi.value],
  ]));
  const diagnostics = unknownFields.length === 0
    ? []
    : [{ severity: "warning" as const, message: `config.json ignores unsupported fields: ${unknownFields.join(", ")}` }];
  if (selection) {
    try { diagnostics.push(...parseLaunchFile(text).diagnostics); }
    catch (error) { diagnostics.push({ severity: "warning", message: `Unused configuration: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  return { value, diagnostics };
}

export async function readLaunchFile(path: string, selection?: LaunchSelection): Promise<ParsedLaunchFile> {
  try { return parseLaunchFile(await readFile(path, "utf8"), selection); }
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

  public async load(selection?: LaunchSelection): Promise<ParsedLaunchFile> {
    for (const path of [this.#paths.project, this.#paths.global]) {
      try { return await readLaunchFile(path, selection); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return this.#paths.defaults === undefined ? defaultLaunchFile() : parseLaunchFile(this.#paths.defaults, selection);
  }
  public async get(type: AgentType): Promise<ConfiguredLaunch> {
    const value = (await this.load({ type })).value;
    return value.configurationFor(value.autoRunProvider, type);
  }

  public async getFor(platform: AgentPlatformId, type: AgentType): Promise<ConfiguredLaunch> {
    return (await this.load({ platform, type })).value.configurationFor(platform, type);
  }
  public async getDelegationFor(platform: AgentPlatformId, task: DelegationTask): Promise<ConfiguredLaunch> {
    return (await this.load({ platform, task })).value.delegationConfigurationFor(platform, task);
  }
  public async getForWorktree(platform: AgentPlatformId, type: AgentType, cwd: string): Promise<ConfiguredLaunch> {
    return (await this.#forCheckout(cwd)).getFor(platform, type);
  }
  public async getDelegationForWorktree(platform: AgentPlatformId, task: DelegationTask, cwd: string): Promise<ConfiguredLaunch> {
    return (await this.#forCheckout(cwd)).getDelegationFor(platform, task);
  }

  async #forCheckout(cwd: string): Promise<FileLaunchConfigurationSource> {
    const projectRoot = dirname(dirname(this.#paths.project));
    const contains = (parent: string, child: string): boolean => {
      const offset = relative(resolve(parent), resolve(child));
      return offset === "" || offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
    };
    const inProject = contains(projectRoot, cwd);
    // A delegation can start below the checkout root. Resolve its Git checkout,
    // not cwd/.harness, and never fall back to the other window's configuration.
    const checkoutRoot = await new ProcessGitClient(cwd).checkoutRoot().catch(() => inProject ? projectRoot : cwd);
    // Preserve explicitly opened subfolder projects, including non-Git folders.
    if (inProject && contains(checkoutRoot, projectRoot)) return new FileLaunchConfigurationSource(this.#paths);
    return new FileLaunchConfigurationSource({ ...this.#paths, project: join(checkoutRoot, ".harness", "config.json") });
  }
}
