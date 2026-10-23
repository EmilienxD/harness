import rules from "../../../../harness/productivity/subagents/runtime/src/subagents_runtime/prompt-commands.json";
import type { AgentPlatformId } from "./agent-platform.js";

// Python's Unicode \w means letters, numbers and underscore. Every \w in
// the shared pattern is inside a character class; use the same set in JS.
const invocation = new RegExp(rules.invocationPattern.replaceAll("\\w", "\\p{L}\\p{N}_"), "gu");
const commands: Record<AgentPlatformId, ReadonlySet<string>> = {
  claude: new Set(rules.commands.claude),
  chatgpt: new Set(rules.commands.chatgpt),
  pi: new Set(rules.commands.pi),
};

/** Neutralize native CLI commands while preserving skill invocations and paths. */
export function sanitizePromptCommands(prompt: string, provider: AgentPlatformId): string {
  return prompt.replace(invocation, (match: string, name: string) => commands[provider].has(name) ? name : match);
}
