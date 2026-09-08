import type { AgentType } from "../domain/contracts.js";
import type { ConfiguredLaunch } from "../platform/agent-platform.js";
import { LaunchFileError, type PlatformLaunchFile } from "../platform/launch-configuration.js";
import type { ChatGptLaunchConfiguration } from "./launch.js";

const ROOT_FIELDS = new Set(["version", "platform", "command", "interactive"]);
const PROFILE_FIELDS = new Set(["model", "effort"]);
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const CLAUDE_MODELS = new Set(["haiku", "sonnet", "opus"]);

export function parseChatGptLaunchFile(root: Record<string, unknown>): { readonly value: PlatformLaunchFile; readonly unknownFields: readonly string[] } {
  const unknown = Object.keys(root).filter((field) => !ROOT_FIELDS.has(field));
  const command = parseCommand(root.command);
  const input = root.interactive === undefined ? {} : object(root.interactive, "launch.json interactive");
  unknown.push(...Object.keys(input).filter((field) => !PROFILE_FIELDS.has(field)).map((field) => `interactive.${field}`));
  const model = inheritedString(input.model, "model");
  if (model !== undefined && CLAUDE_MODELS.has(model)) throw new LaunchFileError(`launch.json interactive.model is not valid for platform chatgpt; received Claude model ${JSON.stringify(model)}`);
  const effort = input.effort === undefined || input.effort === "inherit" ? undefined : input.effort;
  if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.includes(effort as never))) throw new LaunchFileError(`launch.json interactive.effort is not valid for platform chatgpt; expected inherit or ${EFFORTS.join(", ")}`);
  return { value: new ChatGptLaunchFile(command, model, effort as ChatGptLaunchConfiguration["declaredEffort"]), unknownFields: unknown };
}

class ChatGptLaunchFile implements PlatformLaunchFile {
  public readonly platform = "chatgpt" as const;
  public constructor(private readonly command: readonly string[], private readonly model?: string, private readonly effort?: ChatGptLaunchConfiguration["declaredEffort"]) {}
  public configuration(type: AgentType): ConfiguredLaunch {
    if (type !== "interactive") throw new LaunchFileError(`launch.json platform chatgpt does not support ${type} sessions yet`);
    return { platform: this.platform, settings: { shape: "default", declaredCommand: this.command, ...(this.model === undefined ? {} : { declaredModel: this.model }), ...(this.effort === undefined ? {} : { declaredEffort: this.effort }) } satisfies ChatGptLaunchConfiguration };
  }
}

function object(value: unknown, path: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LaunchFileError(`${path} must be a JSON object`); return value as Record<string, unknown>; }
function parseCommand(value: unknown): readonly string[] { if (value === undefined) return ["codex"]; if (!Array.isArray(value) || value.length === 0 || !value.every((token) => typeof token === "string" && token.trim().length > 0)) throw new LaunchFileError("launch.json command must be a non-empty array of non-empty strings"); return value; }
function inheritedString(value: unknown, field: string): string | undefined { if (value === undefined || value === "inherit") return undefined; if (typeof value !== "string" || value.trim().length === 0) throw new LaunchFileError(`launch.json interactive.${field} must be inherit or a non-empty string`); return value; }
