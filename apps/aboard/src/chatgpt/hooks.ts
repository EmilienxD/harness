import type { AgentType } from "../domain/contracts.js";

type CodexHookEvent = "SessionStart" | "UserPromptSubmit" | "SessionEnd" | "Stop" | "StopFailure" | "PostCompact" | "PreToolUse";
type AboardHookRoute = "session-start" | "prompt-submit" | "session-end" | "worker-stop" | "worker-stop-failure" | "worker-reground" | "worker-post-compact" | "worker-guard";

interface CodexCommandHook {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
  readonly async?: boolean;
}

interface CodexHookGroup {
  readonly matcher?: string;
  readonly hooks: readonly CodexCommandHook[];
}

export interface CodexHookDefinition {
  readonly event: CodexHookEvent;
  readonly groups: readonly CodexHookGroup[];
}

const RESULT_REPORTING_TYPES: ReadonlySet<AgentType> = new Set(["explore", "address", "review"]);

function command(script: string, route: AboardHookRoute, options: { readonly timeout?: number; readonly async?: boolean } = {}): CodexCommandHook {
  if (/["\r\n]/u.test(script)) throw new Error("Codex hook script paths cannot contain quotes or newlines");
  return {
    type: "command",
    command: `uv run --no-project --no-managed-python "${script}" ${route}`,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.async === true ? { async: true } : {}),
  };
}

/** Definitions contain stable runtime paths only; launch identity stays in the process environment. */
export function codexHookDefinitions(script: string, agentType: AgentType, guarded: boolean): readonly CodexHookDefinition[] {
  const reporting = RESULT_REPORTING_TYPES.has(agentType);
  return [
    {
      event: "SessionStart",
      groups: [
        { matcher: "startup|resume|fork", hooks: [command(script, "session-start")] },
        ...(reporting ? [{ matcher: "compact", hooks: [command(script, "worker-reground", { timeout: 120 })] }] : []),
      ],
    },
    // Confirms a prompt Aboard typed; in the background so it never delays the user's own prompts.
    { event: "UserPromptSubmit", groups: [{ hooks: [command(script, "prompt-submit", { async: true })] }] },
    { event: "SessionEnd", groups: [{ hooks: [command(script, "session-end", { timeout: 3 })] }] },
    { event: "Stop", groups: [{ hooks: [command(script, "worker-stop")] }] },
    ...(reporting ? [
      { event: "StopFailure" as const, groups: [{ hooks: [command(script, "worker-stop-failure")] }] },
      { event: "PostCompact" as const, groups: [{ matcher: "manual|auto", hooks: [command(script, "worker-post-compact")] }] },
    ] : []),
    ...(guarded ? [
      { event: "PreToolUse" as const, groups: [{ matcher: "Bash|Agent", hooks: [command(script, "worker-guard")] }] },
    ] : []),
  ];
}

function inlineToml(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).map(([key, entry]) => `${key}=${inlineToml(entry)}`).join(",")}}`;
  }
  throw new Error("Codex hook definitions cannot contain null or undefined values");
}

export function codexHookConfigArguments(script: string, agentType: AgentType, guarded: boolean): readonly string[] {
  return codexHookDefinitions(script, agentType, guarded)
    .flatMap(({ event, groups }) => ["-c", `hooks.${event}=${inlineToml(groups)}`]);
}
