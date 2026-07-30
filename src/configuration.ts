import { DEFAULT_MAX_INLINE_PROMPT_CHARS, MANAGER_TOOL_PRESETS, WORKER_PERMISSION_MODES, type ManagerToolPreset, type WorkerPermissionMode } from "./claude/launch.js";
import { DEFAULT_BRIDGE_PORT } from "./bridge/server.js";
import type { AutoReviewSetting } from "./github/review.js";

export interface ConfigurationReader { get(section: string): unknown; }
export interface AboardConfiguration {
  readonly bridgePort: number;
  readonly maxInlinePromptChars: number;
  readonly managerToolPreset: ManagerToolPreset;
  readonly managerDisallowedTools: readonly string[];
  readonly workerPermissionMode: WorkerPermissionMode;
  readonly autoReview: AutoReviewSetting;
  readonly managerStopTimeoutSeconds: number;
  readonly managerPromptTimeoutSeconds: number;
  readonly managerSessionStartTimeoutSeconds: number;
}
export interface ConfigurationDiagnostic { readonly setting: string; readonly message: string; readonly severity: "warning" | "error"; }
export interface ConfigurationResult { readonly value: AboardConfiguration; readonly diagnostics: readonly ConfigurationDiagnostic[]; }

const AUTO_REVIEW = ["never", "hitl", "all"] as const;
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
    managerToolPreset: choice(reader, "aboard.manager.toolPreset", MANAGER_TOOL_PRESETS, "read-only", diagnostics),
    managerDisallowedTools,
    workerPermissionMode: choice(reader, "aboard.workers.permissionMode", WORKER_PERMISSION_MODES, "default", diagnostics),
    autoReview: choice(reader, "aboard.review.autoReview", AUTO_REVIEW, "never", diagnostics),
    managerStopTimeoutSeconds: integer(reader, "aboard.timeouts.managerStop", 3_600, 1, 86_400, diagnostics),
    managerPromptTimeoutSeconds: integer(reader, "aboard.timeouts.managerPrompt", 60, 1, 600, diagnostics),
    managerSessionStartTimeoutSeconds: integer(reader, "aboard.timeouts.managerSessionStart", 120, 1, 3_600, diagnostics),
  }, diagnostics };
}

export const MANAGER_RESTART_SETTINGS = new Set(["aboard.manager.toolPreset", "aboard.manager.disallowedTools"]);
