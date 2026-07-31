import { DEFAULT_CLAUDE_COMMAND, DEFAULT_MAX_INLINE_PROMPT_CHARS, WORKER_PERMISSION_MODES, parseClaudeCommand, type WorkerPermissionMode } from "./claude/launch.js";
import { DEFAULT_BRIDGE_PORT } from "./bridge/server.js";
import { AUTO_RUN_SCOPES, MERGE_STRATEGIES, type AutoRunScope, type AutoRunSettings, type MergeStrategy } from "./domain/auto-run.js";

export interface ConfigurationReader { get(section: string): unknown; }
export interface AboardConfiguration {
  readonly bridgePort: number;
  readonly maxInlinePromptChars: number;
  /** `aboard.launch.claudeCommand` as tokens: the program, then its own fixed arguments. */
  readonly claudeCommand: readonly string[];
  readonly managerDisallowedTools: readonly string[];
  readonly workerPermissionMode: WorkerPermissionMode;
  readonly autoRun: AutoRunSettings;
  readonly managerStopTimeoutSeconds: number;
  readonly managerPromptTimeoutSeconds: number;
  readonly managerSessionStartTimeoutSeconds: number;
}
export interface ConfigurationDiagnostic { readonly setting: string; readonly message: string; readonly severity: "warning" | "error"; }
export interface ConfigurationResult { readonly value: AboardConfiguration; readonly diagnostics: readonly ConfigurationDiagnostic[]; }

/** Every setting aboard reads, in the order it appears in the contributed schema. */
export const ABOARD_SETTINGS = [
  "aboard.bridge.port",
  "aboard.launch.claudeCommand",
  "aboard.launch.maxInlinePromptChars",
  "aboard.workers.permissionMode",
  "aboard.manager.disallowedTools",
  "aboard.autoRun.review",
  "aboard.autoRun.scope",
  "aboard.autoRun.pauseAfterHitl",
  "aboard.autoRun.mergeStrategy",
  "aboard.autoRun.pollSeconds",
  "aboard.timeouts.managerStop",
  "aboard.timeouts.managerPrompt",
  "aboard.timeouts.managerSessionStart",
] as const;
export type AboardSetting = (typeof ABOARD_SETTINGS)[number];
const KNOWN_SETTINGS: ReadonlySet<string> = new Set(ABOARD_SETTINGS);

/** Project-scoped override file, relative to the workspace root. */
export const PROJECT_SETTINGS_PATH = ".aboard/settings.json";

export interface ProjectSettings {
  /** Recognised settings, keyed by their fully qualified `aboard.*` name. */
  readonly values: ReadonlyMap<string, unknown>;
  readonly diagnostics: readonly ConfigurationDiagnostic[];
}
export const EMPTY_PROJECT_SETTINGS: ProjectSettings = { values: new Map(), diagnostics: [] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flattens nested objects into dotted keys so `{"aboard":{"bridge":{"port":1}}}`
 * and `{"aboard.bridge.port":1}` describe the same setting. Recursion stops at a
 * recognised key, because a setting's own value may legitimately be an object.
 */
function flatten(source: Record<string, unknown>, prefix: string, into: Map<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(value) && !KNOWN_SETTINGS.has(path)) flatten(value, path, into);
    else into.set(path, value);
  }
}

/**
 * Parses `.aboard/settings.json`. Values are not validated here: they flow
 * through the same per-setting validation as VS Code settings, so a bad project
 * value produces the same diagnostic and the same fallback.
 */
export function parseProjectSettings(text: string): ProjectSettings {
  const diagnostics: ConfigurationDiagnostic[] = [];
  const fail = (message: string): ProjectSettings => ({ values: new Map(), diagnostics: [{ setting: PROJECT_SETTINGS_PATH, severity: "error", message: `${PROJECT_SETTINGS_PATH}: ${message} Project overrides are ignored.` }] });
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch (error) { return fail(`not valid JSON (${error instanceof Error ? error.message : "parse error"}).`); }
  if (!isPlainObject(parsed)) return fail("expected a JSON object of aboard settings.");

  const flat = new Map<string, unknown>();
  flatten(parsed, "", flat);
  const values = new Map<string, unknown>();
  for (const [key, value] of flat) {
    // The `aboard.` prefix is redundant inside an aboard-owned file, so accept
    // both spellings rather than failing on the natural one.
    const setting = KNOWN_SETTINGS.has(key) ? key : KNOWN_SETTINGS.has(`aboard.${key}`) ? `aboard.${key}` : undefined;
    if (setting === undefined) { diagnostics.push({ setting: PROJECT_SETTINGS_PATH, severity: "warning", message: `${PROJECT_SETTINGS_PATH}: unknown setting "${key}" is ignored. Known settings are ${ABOARD_SETTINGS.join(", ")}.` }); continue; }
    if (value !== null) values.set(setting, value);
  }
  return { values, diagnostics };
}

export interface LayeredConfigurationSources {
  /** Values VS Code resolves from user, profile, or default scope. */
  readonly user: ConfigurationReader;
  /** Values VS Code resolves from an explicit workspace or folder scope (`.vscode/settings.json`). */
  readonly workspace?: ConfigurationReader;
  /** Recognised values parsed from `.aboard/settings.json`. */
  readonly project?: ReadonlyMap<string, unknown>;
}

/**
 * Precedence, highest first: `.vscode/settings.json`, `.aboard/settings.json`,
 * then user or default scope. A developer's explicit VS Code workspace setting
 * therefore still wins over the checked-in, team-shared project file.
 */
export function createLayeredReader(sources: LayeredConfigurationSources): ConfigurationReader {
  return { get: (section) => sources.workspace?.get(section) ?? sources.project?.get(section) ?? sources.user.get(section) };
}

function flag(reader: ConfigurationReader, setting: string, fallback: boolean, diagnostics: ConfigurationDiagnostic[]): boolean {
  const value = reader.get(setting);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  diagnostics.push({ setting, severity: "warning", message: `${setting} must be a boolean; using ${fallback}.` });
  return fallback;
}
function integer(reader: ConfigurationReader, setting: string, fallback: number, minimum: number, maximum: number, diagnostics: ConfigurationDiagnostic[]): number {
  const value = reader.get(setting);
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum) return value;
  diagnostics.push({ setting, severity: "warning", message: `${setting} must be an integer between ${minimum} and ${maximum}; using ${fallback}.` });
  return fallback;
}
function choice<T extends string>(reader: ConfigurationReader, setting: string, allowed: readonly T[], fallback: T, diagnostics: ConfigurationDiagnostic[]): T {
  const value = reader.get(setting);
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  if (value !== undefined) diagnostics.push({ setting, severity: "warning", message: `${setting} must be one of ${allowed.join(", ")}; using ${fallback}.` });
  return fallback;
}

function claudeCommand(reader: ConfigurationReader, diagnostics: ConfigurationDiagnostic[]): readonly string[] {
  const setting = "aboard.launch.claudeCommand";
  const value = reader.get(setting);
  if (value === undefined) return [...DEFAULT_CLAUDE_COMMAND];
  const parsed = parseClaudeCommand(value);
  if (parsed.ok) return parsed.value;
  diagnostics.push({ setting, severity: "warning", message: `${setting}: ${parsed.reason}; using ${DEFAULT_CLAUDE_COMMAND.join(" ")}.` });
  return [...DEFAULT_CLAUDE_COMMAND];
}

export function readAboardConfiguration(reader: ConfigurationReader): ConfigurationResult {
  const diagnostics: ConfigurationDiagnostic[] = [];
  const rawTools = reader.get("aboard.manager.disallowedTools");
  let managerDisallowedTools: readonly string[] = [];
  if (rawTools !== undefined) {
    if (Array.isArray(rawTools) && rawTools.every((tool) => typeof tool === "string" && tool.trim().length > 0)) managerDisallowedTools = rawTools.map((tool) => tool.trim());
    else diagnostics.push({ setting: "aboard.manager.disallowedTools", severity: "warning", message: "aboard.manager.disallowedTools must contain only non-empty strings; using an empty list." });
  }
  return { value: {
    bridgePort: integer(reader, "aboard.bridge.port", DEFAULT_BRIDGE_PORT, 0, 65_535, diagnostics),
    maxInlinePromptChars: integer(reader, "aboard.launch.maxInlinePromptChars", DEFAULT_MAX_INLINE_PROMPT_CHARS, 0, 32_767, diagnostics),
    claudeCommand: claudeCommand(reader, diagnostics),
    managerDisallowedTools,
    workerPermissionMode: choice(reader, "aboard.workers.permissionMode", WORKER_PERMISSION_MODES, "default", diagnostics),
    autoRun: {
      // Automated review stays opt-in: spec section 7.5's invariant is
      // unchanged, only its shape is.
      review: flag(reader, "aboard.autoRun.review", false, diagnostics),
      scope: choice<AutoRunScope>(reader, "aboard.autoRun.scope", AUTO_RUN_SCOPES, "spec", diagnostics),
      pauseAfterHitl: flag(reader, "aboard.autoRun.pauseAfterHitl", false, diagnostics),
      mergeStrategy: choice<MergeStrategy>(reader, "aboard.autoRun.mergeStrategy", MERGE_STRATEGIES, "squash", diagnostics),
      pollSeconds: integer(reader, "aboard.autoRun.pollSeconds", 30, 1, 3_600, diagnostics),
    },
    managerStopTimeoutSeconds: integer(reader, "aboard.timeouts.managerStop", 3_600, 1, 86_400, diagnostics),
    managerPromptTimeoutSeconds: integer(reader, "aboard.timeouts.managerPrompt", 60, 1, 600, diagnostics),
    managerSessionStartTimeoutSeconds: integer(reader, "aboard.timeouts.managerSessionStart", 120, 1, 3_600, diagnostics),
  }, diagnostics };
}

export const MANAGER_RESTART_SETTINGS = new Set(["aboard.manager.disallowedTools", "aboard.launch.claudeCommand"]);

/**
 * Value-level equivalent of `MANAGER_RESTART_SETTINGS`, for reload paths such as
 * the project settings file where VS Code raises no configuration event.
 */
export function managerLaunchChanged(before: AboardConfiguration, after: AboardConfiguration): boolean {
  const list = (values: readonly string[]) => values.join(" ");
  return list(before.claudeCommand) !== list(after.claudeCommand)
    || list(before.managerDisallowedTools) !== list(after.managerDisallowedTools);
}
