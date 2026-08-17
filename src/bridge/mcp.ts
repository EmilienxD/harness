import { MCP_LAUNCHABLE_AGENT_TYPES, isAutomatedAgentType, isInteractiveAgentType, type AgentId, type AgentType } from "../domain/contracts.js";
import { ROADMAP_TASK_STATUSES, type RoadmapAnchor, type RoadmapTaskStatus } from "../domain/roadmap.js";
import { GitHubBoundaryError, type GitHubClient } from "../github/client.js";
import type { ReviewCoordinator } from "../github/review.js";
import { describeIssueNumbers, formatIssueNumbers } from "../shared/issues.js";
import { DelegationCoordinator, DelegationError, type DelegationLaunchInput } from "./delegation.js";
import { CORE_MCP_TOOLS } from "./mcp-tools.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";

export { CORE_MCP_TOOLS };

const MCP_PROTOCOL_VERSION = "2025-03-26";
export const ABOARD_MCP_TIMEOUT_SECONDS = 3600;
export const ABOARD_MCP_TOOL_PATTERN = "mcp__aboard__*";

/** The MCP registration expands this from each Claude session's environment. */
const AGENT_ID_HEADER = "x-aboard-agent-id";

type JsonRpcId = string | number | null;

export interface AutoRunTrigger {
  start(): Promise<unknown>;
}

export interface McpServices {
  readonly github?: GitHubClient;
  readonly reviews?: ReviewCoordinator;
  readonly autoRun?: AutoRunTrigger;
  /** A user-visible audit line derived from a roadmap operation. */
  readonly log?: (message: string) => void;
}

export type McpCoordinator = Pick<DelegationCoordinator,
  "run" | "spawn" | "spawnInteractive">;

export interface McpHandlerOptions {
  readonly managerAgentId: AgentId;
  readonly services?: McpServices;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpc(id: JsonRpcId, result: unknown): BridgeResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): BridgeResponse {
  return {
    status: 200,
    body: { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
  };
}

function toolResult(value: unknown, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function refusal(status: number, code: string, message: string): BridgeResponse {
  return { status, body: { ok: false, error: { code, message } } };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * `issues` is validated here rather than left to the JSON Schema, which the
 * caller is free to ignore. Duplicates are deduped rather than refused: a
 * repeated number is wrong, not ambiguous, and the caller's intent is
 * unmistakable (`AGENTS.md`).
 */
function parseIssues(value: unknown): { readonly issues: readonly number[]; readonly notices: readonly string[] } | string {
  if (!Array.isArray(value)) return "issues must be an array of positive integers";
  if (value.length === 0) return "issues must contain at least one issue number";
  for (const entry of value) {
    if (!Number.isInteger(entry) || (entry as number) <= 0) return "every entry of issues must be a positive integer";
  }
  const issues = [...new Set(value as readonly number[])];
  return {
    issues,
    notices: issues.length === value.length
      ? []
      : [`issues contained repeated numbers, which were resolved once each: ${formatIssueNumbers(issues)}.`],
  };
}

interface ParsedLaunch {
  readonly input: DelegationLaunchInput;
  readonly interactive: boolean;
  readonly background: boolean;
  readonly notices: readonly string[];
}

const MIN_DESCRIPTION_WORDS = 3;
const MAX_DESCRIPTION_WORDS = 6;

/**
 * Coerces the user-facing label into the 3-6 word range. A malformed label is a
 * cosmetic problem, not a launch-blocking one, so overlong labels are truncated
 * and short ones are extended from the prompt, with the type as the last-resort
 * filler. Returns the label plus a notice when it had to be adjusted.
 */
function normalizeDescription(raw: string, prompt: string | undefined, type: string): { description: string; notice?: string } {
  const words = raw.trim().split(/\s+/);
  if (words.length >= MIN_DESCRIPTION_WORDS && words.length <= MAX_DESCRIPTION_WORDS) {
    return { description: words.join(" ") };
  }
  if (words.length > MAX_DESCRIPTION_WORDS) {
    return {
      description: words.slice(0, MAX_DESCRIPTION_WORDS).join(" "),
      notice: `description exceeded ${MAX_DESCRIPTION_WORDS} words and was truncated to "${words.slice(0, MAX_DESCRIPTION_WORDS).join(" ")}".`,
    };
  }
  const padded = [...words];
  const promptWords = prompt === undefined ? [] : prompt.trim().split(/\s+/).slice(0, 12);
  for (const word of promptWords) {
    if (padded.length >= MIN_DESCRIPTION_WORDS) break;
    padded.push(word.replace(/[^\p{L}\p{N}'-]/gu, ""));
  }
  while (padded.length < MIN_DESCRIPTION_WORDS) padded.push(type);
  return {
    description: padded.join(" "),
    notice: `description was shorter than ${MIN_DESCRIPTION_WORDS} words and was extended to "${padded.join(" ")}".`,
  };
}

function parseLaunch(value: unknown): ParsedLaunch | string {
  if (!isRecord(value)) return "arguments must be an object";
  if (!exactKeys(value, ["type", "prompt", "description", "issues", "interactive", "run_in_background"])) {
    return "arguments contain an unknown property";
  }
  if (!nonEmptyString(value.type) || !MCP_LAUNCHABLE_AGENT_TYPES.includes(value.type as AgentType)) {
    return `type must be one of: ${MCP_LAUNCHABLE_AGENT_TYPES.join(", ")}`;
  }
  const type = value.type as AgentType;
  if (value.interactive !== undefined && typeof value.interactive !== "boolean") return "interactive must be a boolean";
  if (value.interactive === true && isAutomatedAgentType(type)) return `${type} is automated and cannot be launched interactively`;
  if (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") return "run_in_background must be a boolean";
  if (!nonEmptyString(value.description)) return "description must be a non-empty string";
  if (value.prompt !== undefined && !nonEmptyString(value.prompt)) return "prompt must be non-empty when provided";
  const parsedIssues = value.issues === undefined ? undefined : parseIssues(value.issues);
  if (typeof parsedIssues === "string") return parsedIssues;

  const notices: string[] = [...(parsedIssues?.notices ?? [])];
  const label = normalizeDescription(value.description, value.prompt === undefined ? undefined : value.prompt as string, type);
  if (label.notice !== undefined) notices.push(label.notice);
  let interactive = value.interactive === true;
  if (!interactive && isInteractiveAgentType(type)) {
    interactive = true;
    notices.push(`${type} is an interactive type and was launched interactively; no result will be delivered, so continue with the user instead of waiting.`);
  }
  if (interactive && parsedIssues !== undefined && (isInteractiveAgentType(type) || !nonEmptyString(value.prompt))) {
    const ignored = parsedIssues.issues.length === 1 ? "was ignored" : "were ignored";
    notices.push(`${describeIssueNumbers(parsedIssues.issues)} ${ignored}: an interactive session opens with only the opening topic. To hand the session an issue's context, pass it in \`prompt\`.`);
  }
  if (!interactive && !nonEmptyString(value.prompt)) return "prompt is required unless interactive is true";
  const background = !interactive && value.run_in_background === true;
  if (interactive && value.run_in_background === true) {
    notices.push("run_in_background was ignored: an interactive session returns no result to wait for.");
  }
  return {
    input: {
      type: type as DelegationLaunchInput["type"],
      description: label.description,
      ...(value.prompt === undefined ? {} : { prompt: (value.prompt as string).trim() }),
      ...(parsedIssues === undefined ? {} : { issues: parsedIssues.issues }),
    },
    interactive,
    background,
    notices,
  };
}

function parseAfter(value: unknown): { readonly after?: RoadmapAnchor } {
  if (value === undefined) return {};
  if (value === "top") return { after: "top" };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError("after must be a 1-based task position or the string `top`");
  }
  return { after: value };
}

/** How a placement anchor reads in the audit line. */
function describeAnchor(after: RoadmapAnchor | undefined, verb: string): string {
  if (after === undefined) return "appended";
  return after === "top" ? `${verb} to the top` : `${verb} after position ${after}`;
}

function parseStatus(value: unknown): { readonly value?: RoadmapTaskStatus; readonly notices: readonly string[] } {
  if (value === undefined) return { notices: [] };
  if (!nonEmptyString(value) || !ROADMAP_TASK_STATUSES.includes(value as RoadmapTaskStatus)) {
    throw new TypeError(`status must be one of: ${ROADMAP_TASK_STATUSES.join(", ")}`);
  }
  return { value: value as RoadmapTaskStatus, notices: [] };
}

function withNotices(result: unknown, notices: readonly string[]): unknown {
  if (notices.length === 0 || !isRecord(result)) return result;
  return { ...result, notice: notices.join(" ") };
}

async function callTool(
  coordinator: McpCoordinator,
  services: McpServices,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  switch (name) {
    case "run_agent": {
      const parsed = parseLaunch(args);
      if (typeof parsed === "string") throw new TypeError(parsed);
      const launched = parsed.interactive
        ? coordinator.spawnInteractive(parsed.input)
        : parsed.background
          ? coordinator.spawn(parsed.input)
          : coordinator.run(parsed.input, signal);
      return withNotices(await launched, parsed.notices);
    }
    case "todo_create": {
      if (!isRecord(args) || !exactKeys(args, ["subjects", "after"])) throw new TypeError("arguments contain an unknown property");
      if (!Array.isArray(args.subjects) || args.subjects.length === 0 || !args.subjects.every(nonEmptyString)) {
        throw new TypeError("subjects must contain at least one non-empty string");
      }
      const after = parseAfter(args.after);
      if (services.github === undefined) throw new GitHubBoundaryError("command-failed", "GitHub service is unavailable");
      const subjects = args.subjects as readonly string[];
      const created = await services.github.createRoadmapTasks({ subjects, ...after });
      const placed = describeAnchor(after.after, "added");
      services.log?.(`Roadmap #${created.issue}: ${subjects.length} task(s) ${placed} - ${subjects.map((subject) => `"${subject}"`).join(", ")}`);
      return withNotices(
        {
          positions: created.positions ?? [],
          issue: created.issue,
          ...(created.tasks === undefined ? {} : { tasks: created.tasks }),
        },
        created.notices,
      );
    }
    case "todo_update": {
      if (!isRecord(args) || !exactKeys(args, ["task", "expect", "subject", "status", "after"])) throw new TypeError("arguments contain an unknown property");
      if (typeof args.task !== "number" || !Number.isInteger(args.task) || args.task < 1) {
        throw new TypeError("task must be a 1-based task position from the newest roadmap block");
      }
      if (!nonEmptyString(args.expect)) throw new TypeError("expect must be the task's current subject, or at least its first 40 characters");
      if (args.subject !== undefined && !nonEmptyString(args.subject)) throw new TypeError("subject must be non-empty when provided");
      const status = parseStatus(args.status);
      const after = parseAfter(args.after);
      if (args.subject === undefined && status.value === undefined && after.after === undefined) {
        throw new TypeError("subject, status, or after is required: an update with none of them changes nothing");
      }
      if (services.github === undefined) throw new GitHubBoundaryError("command-failed", "GitHub service is unavailable");
      const updated = await services.github.updateRoadmapTask({
        task: args.task,
        expect: args.expect.trim(),
        ...(args.subject === undefined ? {} : { subject: (args.subject as string).trim() }),
        ...(status.value === undefined ? {} : { status: status.value }),
        ...after,
      });
      const changes = [
        ...(args.subject === undefined ? [] : [`retitled to "${(args.subject as string).trim()}"`]),
        ...(status.value === undefined ? [] : [`marked ${status.value}`]),
        ...(after.after === undefined ? [] : [describeAnchor(after.after, "moved")]),
      ];
      services.log?.(`Roadmap #${updated.issue}: task at position ${args.task} ${changes.join(", ")}`);
      return withNotices(
        {
          task: updated.task ?? null,
          issue: updated.issue,
          ...(updated.tasks === undefined ? {} : { tasks: updated.tasks }),
        },
        [...status.notices, ...updated.notices],
      );
    }
    case "start_auto_run": {
      if (!isRecord(args) || !exactKeys(args, [])) throw new TypeError("start_auto_run takes no arguments");
      if (services.autoRun === undefined) throw new GitHubBoundaryError("command-failed", "The auto-run engine is unavailable");
      return services.autoRun.start();
    }
    case "review_pr": {
      if (!isRecord(args) || !exactKeys(args, ["pr", "focus"])) throw new TypeError("arguments contain an unknown property");
      if (args.pr !== undefined && (!Number.isInteger(args.pr) || (args.pr as number) <= 0)) throw new TypeError("pr must be a positive integer when provided");
      if (args.focus !== undefined && !nonEmptyString(args.focus)) throw new TypeError("focus must be non-empty when provided");
      if (services.reviews === undefined) throw new GitHubBoundaryError("command-failed", "Review service is unavailable");
      return services.reviews.review({
        ...(args.pr === undefined ? {} : { pr: args.pr as number }),
        ...(args.focus === undefined ? {} : { focus: (args.focus as string).trim() }),
      });
    }
    default:
      throw new TypeError(`Unknown MCP tool ${name}`);
  }
}

export function createMcpHandler(
  coordinator: McpCoordinator,
  options: McpHandlerOptions,
): BridgeRequestHandler {
  const services = options.services ?? {};
  return async (request) => {
    if (request.url.pathname !== "/mcp") return protocolError(404, "not-found", "Route not found");
    if (request.method === "GET") return protocolError(405, "invalid-request", "This stateless MCP endpoint accepts POST requests");
    if (request.method !== "POST") return protocolError(405, "invalid-request", "Method not allowed");

    const caller = request.headers[AGENT_ID_HEADER];
    if (caller !== options.managerAgentId) {
      return refusal(403, "not-the-manager", "This MCP server is the Manager's. Only the Aboard Manager session may orchestrate the fleet.");
    }

    if (!isRecord(request.body) || request.body.jsonrpc !== "2.0" || typeof request.body.method !== "string") {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const id = typeof request.body.id === "string" || typeof request.body.id === "number" || request.body.id === null
      ? request.body.id
      : null;
    const params = request.body.params;

    switch (request.body.method) {
      case "initialize":
        return jsonRpc(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "aboard", version: "0.0.0" },
          instructions: "Use Aboard tools to launch visible Claude Code terminals, evolve the roadmap, start auto-runs, and reopen pull-request sessions.",
        });
      case "notifications/initialized":
        return { status: 202 };
      case "ping":
        return jsonRpc(id, {});
      case "tools/list":
        return jsonRpc(id, { tools: CORE_MCP_TOOLS });
      case "tools/call": {
        if (!isRecord(params) || !nonEmptyString(params.name)) return jsonRpcError(id, -32602, "Invalid params");
        try {
          return jsonRpc(id, toolResult(await callTool(coordinator, services, params.name, params.arguments ?? {}, request.signal)));
        } catch (error) {
          if (error instanceof TypeError) return jsonRpcError(id, -32602, error.message);
          if (error instanceof DelegationError) {
            return jsonRpc(id, toolResult({ code: error.code, message: error.message, details: error.details }, true));
          }
          if (error instanceof GitHubBoundaryError) {
            return jsonRpc(id, toolResult({ code: error.code, message: error.message, details: error.details }, true));
          }
          throw error;
        }
      }
      default:
        return jsonRpcError(id, -32601, "Method not found");
    }
  };
}
