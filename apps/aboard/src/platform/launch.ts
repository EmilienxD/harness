import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { LaunchRestrictions, WriteCapability } from "../domain/capability.js";
import { isAutoRunWorkerType, type AgentId, type AgentType, type SessionId } from "../domain/contracts.js";
import type { IssueDifficulty } from "../shared/labels.js";
import type { ResolvedPrompt } from "./prompts.js";
import type { ShellKind } from "./shell.js";

export const DEFAULT_RUNTIME_DIRECTORY = join(tmpdir(), "abd-runtime");
export const DEFAULT_MAX_INLINE_PROMPT_CHARS = 4000;
export const MAX_COMMAND_LINE_CHARS: Readonly<Record<ShellKind, number>> = {
  cmd: 8_000,
  powershell: 24_000,
  "git-bash": 24_000,
};

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
const EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVEL_SET.has(value);
}

export const BY_DIFFICULTY = "by-difficulty";
export type ByDifficulty = typeof BY_DIFFICULTY;
export type DeclaredEffort = EffortLevel | ByDifficulty;

export type LaunchPlanErrorCode =
  | "invalid-tool-rule" | "invalid-model" | "invalid-effort" | "invalid-frontmatter"
  | "invalid-session-id" | "unsafe-agent-id" | "unsafe-spill-path" | "invalid-threshold"
  | "invalid-command" | "command-line-too-long" | "missing-prompt" | "shape-not-allowed";

export class LaunchPlanError extends Error {
  public constructor(public readonly code: LaunchPlanErrorCode, message: string) { super(message); }
}

export interface RuntimeFile {
  readonly agentId: AgentId;
  readonly relativePath: string;
  readonly contents: string;
}

export type PromptSpillFile = RuntimeFile;
export type WrapperRequestFile = RuntimeFile;
export type PromptDelivery = "none" | "inline" | "spilled";

export interface LaunchPlan {
  readonly kind: "start" | "resume";
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly shell: ShellKind;
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly writeCapability: WriteCapability;
  readonly requiresWriteLease: boolean;
  readonly promptDelivery: PromptDelivery;
  readonly spill?: PromptSpillFile;
  readonly task?: PromptSpillFile;
  readonly chromeRequired?: true;
  readonly guard?: RuntimeFile;
  readonly permissionProfile?: string;
  readonly wrapperRequest?: WrapperRequestFile;
  readonly runtimeDirectory: string;
  readonly providerEnvironment?: Readonly<Record<string, string>>;
}

export interface SessionWrapperLayout {
  readonly script: string;
  lockPathFor(agentId: AgentId): string;
  mintLaunchCode(): string;
}

export interface PlatformLaunchRequest {
  readonly cwd?: string | undefined;
  readonly forkSessionId?: SessionId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly agentType: AgentType;
  readonly shell: ShellKind;
  readonly executionMode?: import("../domain/contracts.js").ExecutionMode | undefined;
  readonly attended?: boolean | undefined;
  readonly skill?: string | undefined;
  readonly autoRunRestricted?: true | undefined;
  readonly model?: string | undefined;
  /** Explicit child selection, ahead of the configured launch profile. */
  readonly modelOverride?: string | undefined;
  readonly effort?: EffortLevel | undefined;
  readonly difficulty?: IssueDifficulty | undefined;
  readonly command?: readonly string[] | undefined;
  readonly chrome?: true | undefined;
  readonly maxInlinePromptChars?: number | undefined;
  readonly runtimeDirectory?: string | undefined;
  readonly promptRoot?: string | undefined;
  readonly wrapper?: SessionWrapperLayout | undefined;
  readonly writableRoots?: readonly string[] | undefined;
  readonly configuration: unknown;
  readonly prompt?: ResolvedPrompt | string | undefined;
  readonly restrictions?: LaunchRestrictions | undefined;
}

export type PlatformResumeRequest = PlatformLaunchRequest;

export function requiresWriteLease(agentType: AgentType, capability: WriteCapability): boolean {
  return isAutoRunWorkerType(agentType) && capability === "write-capable";
}

export function promptSpillRoot(runtimeDirectory: string, promptRoot?: string): string {
  if (promptRoot !== undefined) return promptRoot;
  const identity = createHash("sha256").update(resolve(runtimeDirectory)).digest("hex");
  return join(tmpdir(), "abd-prompts", identity);
}

export function taskPromptPath(runtimeDirectory: string, agentId: AgentId, promptRoot?: string): string {
  const path = `${promptSpillRoot(runtimeDirectory, promptRoot).replaceAll("\\", "/")}/${agentId}/task.md`;
  if (/\s/.test(path)) throw new LaunchPlanError("unsafe-spill-path", `Prompt spill path must not contain whitespace: ${path}`);
  return path;
}
