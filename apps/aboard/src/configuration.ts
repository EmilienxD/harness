import { DEFAULT_MAX_INLINE_PROMPT_CHARS } from "./platform/launch.js";
import { DEFAULT_BRIDGE_PORT } from "./bridge/server.js";

import { AUTO_RUN_BRANCH_MODES, DEFAULT_ISSUE_CONTEXT_DEPTH, DISCARD_BEHAVIORS, MAX_ISSUE_CONTEXT_DEPTH, MERGE_STRATEGIES, type AutoRunSettings, type AutoRunBranchMode, type DiscardBehavior, type MergeStrategy } from "./domain/auto-run.js";

export interface ConfigurationReader { get(section: string): unknown; }
export interface AboardConfiguration {
  readonly bridgePort: number;
  readonly maxInlinePromptChars: number;
  readonly closeTerminalOnSessionEnd: boolean;
  readonly autoRun: AutoRunSettings;
}
export interface ConfigurationDiagnostic { readonly setting: string; readonly message: string; readonly severity: "warning" | "error"; }
export interface ConfigurationResult { readonly value: AboardConfiguration; readonly diagnostics: readonly ConfigurationDiagnostic[]; }

/** Every setting aboard reads, in the order it appears in the contributed schema. */
export const ABOARD_SETTINGS = [
  "aboard.bridge.port",
  "aboard.launch.maxInlinePromptChars",
  "aboard.terminals.closeOnSessionEnd",
  "aboard.autoRun.review",
  "aboard.autoRun.branchMode",
  "aboard.autoRun.exploreBeforeAddress",
  "aboard.autoRun.issueContextDepth",
  "aboard.autoRun.prompt",
  "aboard.autoRun.mergeStrategy",
  "aboard.autoRun.mergeRunPullRequest",
  "aboard.autoRun.discardBehavior",
  "aboard.autoRun.worktree.enabled",
  "aboard.autoRun.worktree.root",
  "aboard.autoRun.worktree.keep",
  "aboard.autoRun.worktree.setupTimeoutSeconds",
] as const;
export type AboardSetting = (typeof ABOARD_SETTINGS)[number];
const KNOWN_SETTINGS: ReadonlySet<string> = new Set(ABOARD_SETTINGS);

/** Project-scoped override file, relative to the workspace root. */
export const PROJECT_SETTINGS_PATH = ".abd/settings.json";

export interface ProjectSettings {
  /** Recognised settings, keyed by their fully qualified `aboard.*` name. */
  readonly values: ReadonlyMap<string, unknown>;
  readonly diagnostics: readonly ConfigurationDiagnostic[];
}
export const EMPTY_PROJECT_SETTINGS: ProjectSettings = { values: new Map(), diagnostics: [] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flatten(source: Record<string, unknown>, prefix: string, into: Map<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(value) && !KNOWN_SETTINGS.has(path)) flatten(value, path, into);
    else into.set(path, value);
  }
}

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
  /** Recognised values parsed from `.abd/settings.json`. */
  readonly project?: ReadonlyMap<string, unknown>;
}

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
function text(reader: ConfigurationReader, setting: string, fallback: string, diagnostics: ConfigurationDiagnostic[]): string {
  const value = reader.get(setting);
  if (value === undefined) return fallback;
  if (typeof value === "string") return value.trim();
  diagnostics.push({ setting, severity: "warning", message: `${setting} must be a string; using ${fallback === "" ? "the default" : fallback}.` });
  return fallback;
}
function choice<T extends string>(reader: ConfigurationReader, setting: string, allowed: readonly T[], fallback: T, diagnostics: ConfigurationDiagnostic[]): T {
  const value = reader.get(setting);
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  if (value !== undefined) diagnostics.push({ setting, severity: "warning", message: `${setting} must be one of ${allowed.join(", ")}; using ${fallback}.` });
  return fallback;
}

export function readAboardConfiguration(reader: ConfigurationReader): ConfigurationResult {
  const diagnostics: ConfigurationDiagnostic[] = [];
  return { value: {
    bridgePort: integer(reader, "aboard.bridge.port", DEFAULT_BRIDGE_PORT, 0, 65_535, diagnostics),
    maxInlinePromptChars: integer(reader, "aboard.launch.maxInlinePromptChars", DEFAULT_MAX_INLINE_PROMPT_CHARS, 0, 32_767, diagnostics),
    closeTerminalOnSessionEnd: flag(reader, "aboard.terminals.closeOnSessionEnd", false, diagnostics),
    autoRun: {
      branchMode: choice<AutoRunBranchMode>(reader, "aboard.autoRun.branchMode", AUTO_RUN_BRANCH_MODES, "per-issue", diagnostics),
      review: flag(reader, "aboard.autoRun.review", false, diagnostics),
      exploreBeforeAddress: flag(reader, "aboard.autoRun.exploreBeforeAddress", false, diagnostics),
      issueContextDepth: integer(reader, "aboard.autoRun.issueContextDepth", DEFAULT_ISSUE_CONTEXT_DEPTH, 0, MAX_ISSUE_CONTEXT_DEPTH, diagnostics),
      permanentPrompt: text(reader, "aboard.autoRun.prompt", "", diagnostics),
      mergeStrategy: choice<MergeStrategy>(reader, "aboard.autoRun.mergeStrategy", MERGE_STRATEGIES, "squash", diagnostics),
      mergeRunPullRequest: flag(reader, "aboard.autoRun.mergeRunPullRequest", false, diagnostics),
      discardBehavior: choice<DiscardBehavior>(reader, "aboard.autoRun.discardBehavior", DISCARD_BEHAVIORS, "record-only", diagnostics),
      worktree: {
        enabled: flag(reader, "aboard.autoRun.worktree.enabled", false, diagnostics),
        root: text(reader, "aboard.autoRun.worktree.root", "", diagnostics),
        keep: flag(reader, "aboard.autoRun.worktree.keep", false, diagnostics),
        setupTimeoutSeconds: integer(reader, "aboard.autoRun.worktree.setupTimeoutSeconds", 600, 1, 86_400, diagnostics),
      },
    },
  }, diagnostics };
}
