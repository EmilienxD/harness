/**
 * The Manager's delegation surface (spec section 6), served to the
 * `.aboard/scripts/aboard_cli.py` command rather than to an MCP client.
 *
 * aboard used to publish these five actions as an HTTP MCP server registered in
 * the project's `.mcp.json`. That registration is project-scoped, so the server
 * entered *every* Claude Code session in the workspace — the user's own included
 * — where it competed with the MCP servers they had configured themselves, and
 * every one of those sessions paid for its tool schemas in context whether or
 * not it could act on them. A command costs nothing to a session that never runs
 * it, and it is reachable only where it is documented.
 *
 * Isolation is structural rather than conventional. The command is described in
 * the Manager's system prompt and nowhere else, only the Manager's terminal
 * carries `ABOARD_CLI`, and every request here is checked against the recorded
 * Manager's agent id — so a worker that learned the script's path still cannot
 * launch agents with it. That check replaces the `--disallowedTools=mcp__aboard__*`
 * every non-Manager launch used to carry, and is strictly stronger: the deny
 * rule kept the tools out of a worker's context but left the bridge itself open
 * to anything holding the token.
 */

import { CLI_LAUNCHABLE_AGENT_TYPES, isAutomatedAgentType, isInteractiveAgentType, type AgentId, type AgentType } from "../domain/contracts.js";
import { ROADMAP_TASK_STATUSES, type RoadmapTaskStatus } from "../domain/roadmap.js";
import { DelegationCoordinator, DelegationError, type DelegationLaunchInput } from "./delegation.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";
import { GitHubBoundaryError, type GitHubClient } from "../github/client.js";
import type { ReviewCoordinator } from "../github/review.js";

/**
 * How long a foreground launch may block, matching the Manager Stop hook
 * timeout (`AGENTS.md`). It is not enforced here — the
 * bridge waits as long as the caller does — but it is what the Manager terminal's
 * `BASH_MAX_TIMEOUT_MS` is set from, so a foreground delegation can outlive the
 * Bash tool's own ten-minute ceiling.
 */
export const ABOARD_FOREGROUND_TIMEOUT_SECONDS = 3600;

/** The header the CLI proves its identity with, from `ABOARD_AGENT_ID`. */
const AGENT_ID_HEADER = "x-aboard-agent-id";

const CLI_ROUTES = {
  "/cli/agent": "agent",
  "/cli/todo-create": "todo-create",
  "/cli/todo-update": "todo-update",
  "/cli/auto-run": "auto-run",
  "/cli/review-pr": "review-pr",
  "/cli/release-lease": "release-lease",
} as const;

type CliCommand = (typeof CLI_ROUTES)[keyof typeof CLI_ROUTES];

export interface CliServices {
  readonly github?: GitHubClient;
  readonly reviews?: ReviewCoordinator;
  readonly autoRun?: AutoRunTrigger;
  /**
   * Where a roadmap edit is reported to the user. The line is **derived from
   * the operation**, which is what dropping `--reason` bought: a narrated
   * reason existed only because full-body replacement is opaque, and it could
   * disagree with the edit it described. A derived line cannot.
   */
  readonly log?: (message: string) => void;
}

export interface AutoRunTrigger {
  start(): Promise<unknown>;
}

export type CliCoordinator = Pick<DelegationCoordinator,
  "run" | "spawn" | "spawnInteractive" | "releaseLease">;

export interface CliHandlerOptions {
  /**
   * The one caller this surface answers. It is read once at activation and is
   * stable across Manager restarts, so a resumed Manager keeps its access and a
   * worker never gains it.
   */
  readonly managerAgentId: AgentId;
  readonly services?: CliServices;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok(result: unknown): BridgeResponse {
  return { status: 200, body: { ok: true, result } };
}

/**
 * A refusal the caller is expected to read and act on — an invalid argument, a
 * lease held by someone else, a `gh` call that failed. The CLI prints the
 * message and exits non-zero, so the Manager sees the reason rather than a
 * status code.
 */
function refusal(status: number, code: string, message: string, details?: unknown): BridgeResponse {
  return {
    status,
    body: { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } },
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

interface ParsedLaunch {
  readonly input: DelegationLaunchInput;
  readonly interactive: boolean;
  /** Only meaningful for automated launches; an interactive session has no result. */
  readonly background: boolean;
  /**
   * Corrections applied to a launch that was still unambiguous. They are
   * returned with the result so the Manager learns what actually happened.
   */
  readonly notices: readonly string[];
}

function parseLaunch(value: unknown): ParsedLaunch | string {
  if (!isRecord(value)) return "arguments must be an object";
  if (!exactKeys(value, ["type", "prompt", "description", "issue", "interactive", "run_in_background"])) {
    return "arguments contain an unknown property";
  }
  // The CLI's `--type` is free text; this is what actually keeps the
  // implementation types out of the Manager's reach.
  if (!nonEmptyString(value.type) || !CLI_LAUNCHABLE_AGENT_TYPES.includes(value.type as AgentType)) {
    return `--type must be one of: ${CLI_LAUNCHABLE_AGENT_TYPES.join(", ")}`;
  }
  const type = value.type as AgentType;
  if (value.interactive !== undefined && typeof value.interactive !== "boolean") return "interactive must be a boolean";
  if (value.interactive === true && isAutomatedAgentType(type)) return `${type} is automated and cannot be launched with --interactive`;
  if (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") return "run_in_background must be a boolean";
  if (!nonEmptyString(value.description)) return "--description must be a non-empty string";
  const words = value.description.trim().split(/\s+/).length;
  if (words < 3 || words > 6) return "--description must contain 3-6 words";
  if (value.prompt !== undefined && !nonEmptyString(value.prompt)) return "--prompt must be non-empty when provided";
  if (value.issue !== undefined && (!Number.isInteger(value.issue) || (value.issue as number) <= 0)) return "--issue must be a positive integer";

  const notices: string[] = [];
  // An interactive-only type has exactly one valid reading, and its Stop hook is
  // guarded off, so honouring the request beats rejecting it: refusing would cost
  // a round trip and the retry can only be this same launch.
  let interactive = value.interactive === true;
  if (!interactive && isInteractiveAgentType(type)) {
    interactive = true;
    notices.push(`${type} is an interactive type and was launched interactively; no result will be delivered, so continue with the user instead of waiting.`);
  }
  // A missing prompt has no such reading: an automated agent would sit at an
  // empty TUI forever and nothing may be typed into it (spec section 5.3).
  if (!interactive && !nonEmptyString(value.prompt)) return "--prompt is required unless --interactive is set";
  const background = !interactive && value.run_in_background === true;
  if (interactive && value.run_in_background === true) {
    notices.push("--background was ignored: an interactive session returns no result to wait for.");
  }
  return {
    input: {
      type: type as DelegationLaunchInput["type"],
      description: value.description.trim(),
      ...(value.prompt === undefined ? {} : { prompt: (value.prompt as string).trim() }),
      ...(value.issue === undefined ? {} : { issue: value.issue as number }),
    },
    interactive,
    background,
    notices,
  };
}

/** `--after` takes a task id or the literal `top`; absent means append. */
function parseAfter(value: unknown): { readonly after?: string } {
  if (value === undefined) return {};
  if (!nonEmptyString(value)) throw new TypeError("--after must be a task id or `top`");
  return { after: value.trim() };
}

/**
 * `in_progress` is coerced rather than rejected, on the same reading as the
 * launch flags: it has exactly one sensible meaning here. "Being worked on" is
 * already tracked by open `ai:spec` issues, open pull requests, and the auto-run
 * state — all of which the briefing carries — so restating it in the roadmap
 * would be a second copy of a fact that can go out of sync.
 */
function parseStatus(value: unknown): { readonly value?: RoadmapTaskStatus; readonly notices: readonly string[] } {
  if (value === undefined) return { notices: [] };
  if (value === "in_progress") {
    return { value: "pending", notices: ["--status in_progress was recorded as pending: the roadmap tracks what is left to do, and what is in flight is already in the issues, pull requests, and auto-run state your briefing carries."] };
  }
  if (!nonEmptyString(value) || !ROADMAP_TASK_STATUSES.includes(value as RoadmapTaskStatus)) {
    throw new TypeError(`--status must be one of: ${ROADMAP_TASK_STATUSES.join(", ")}`);
  }
  return { value: value as RoadmapTaskStatus, notices: [] };
}

/** Notices ride back with the launch result; a coerced call must not look clean. */
function withNotices(result: unknown, notices: readonly string[]): unknown {
  if (notices.length === 0 || !isRecord(result)) return result;
  return { ...result, notice: notices.join(" ") };
}

async function runCommand(
  coordinator: CliCoordinator,
  services: CliServices,
  command: CliCommand,
  args: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  switch (command) {
    case "agent": {
      const parsed = parseLaunch(args);
      if (typeof parsed === "string") throw new TypeError(parsed);
      const launched = parsed.interactive
        ? coordinator.spawnInteractive(parsed.input)
        : parsed.background
          ? coordinator.spawn(parsed.input)
          : coordinator.run(parsed.input, signal);
      return withNotices(await launched, parsed.notices);
    }
    case "todo-create": {
      if (!isRecord(args) || !exactKeys(args, ["subjects", "after"])) throw new TypeError("arguments contain an unknown property");
      if (!Array.isArray(args.subjects) || args.subjects.length === 0 || !args.subjects.every(nonEmptyString)) {
        throw new TypeError("--subject must be given at least once, with non-empty text");
      }
      const after = parseAfter(args.after);
      if (services.github === undefined) throw new GitHubBoundaryError("command-failed", "GitHub service is unavailable");
      const subjects = args.subjects as readonly string[];
      const created = await services.github.createRoadmapTasks({ subjects, ...after });
      const placed = after.after === undefined ? "appended" : after.after === "top" ? "added at the top" : `added after ${after.after}`;
      services.log?.(`Roadmap #${created.issue}: ${subjects.length} task(s) ${placed} - ${subjects.map((subject) => `"${subject}"`).join(", ")}`);
      return withNotices({ ids: created.ids ?? [], issue: created.issue }, created.notices);
    }
    case "todo-update": {
      if (!isRecord(args) || !exactKeys(args, ["task", "subject", "status", "after"])) throw new TypeError("arguments contain an unknown property");
      if (!nonEmptyString(args.task)) throw new TypeError("--task must be a non-empty task id");
      if (args.subject !== undefined && !nonEmptyString(args.subject)) throw new TypeError("--subject must be non-empty when provided");
      const status = parseStatus(args.status);
      const after = parseAfter(args.after);
      if (args.subject === undefined && status.value === undefined && after.after === undefined) {
        throw new TypeError("--subject, --status, or --after is required: an update with none of them changes nothing");
      }
      if (services.github === undefined) throw new GitHubBoundaryError("command-failed", "GitHub service is unavailable");
      const updated = await services.github.updateRoadmapTask({
        task: args.task.trim(),
        ...(args.subject === undefined ? {} : { subject: (args.subject as string).trim() }),
        ...(status.value === undefined ? {} : { status: status.value }),
        ...after,
      });
      const changes = [
        ...(args.subject === undefined ? [] : [`retitled to "${(args.subject as string).trim()}"`]),
        ...(status.value === undefined ? [] : [`marked ${status.value}`]),
        ...(after.after === undefined ? [] : [after.after === "top" ? "moved to the top" : `moved after ${after.after}`]),
      ];
      services.log?.(`Roadmap #${updated.issue}: task ${args.task.trim()} ${changes.join(", ")}`);
      return withNotices(
        { task: updated.task ?? null, issue: updated.issue },
        [...status.notices, ...updated.notices],
      );
    }
    case "auto-run": {
      if (!isRecord(args) || !exactKeys(args, [])) throw new TypeError("the auto command takes no arguments");
      if (services.autoRun === undefined) throw new GitHubBoundaryError("command-failed", "The auto-run engine is unavailable");
      // Non-blocking: a multi-issue run outlives the command that started it,
      // and blocking would pin the Manager's turn for the whole run.
      return services.autoRun.start();
    }
    case "review-pr": {
      if (!isRecord(args) || !exactKeys(args, ["pr", "focus"])) throw new TypeError("arguments contain an unknown property");
      if (args.pr !== undefined && (!Number.isInteger(args.pr) || (args.pr as number) <= 0)) throw new TypeError("--pr must be a positive integer when provided");
      if (args.focus !== undefined && !nonEmptyString(args.focus)) throw new TypeError("--focus must be non-empty when provided");
      if (services.reviews === undefined) throw new GitHubBoundaryError("command-failed", "Review service is unavailable");
      return services.reviews.review({
        ...(args.pr === undefined ? {} : { pr: args.pr as number }),
        ...(args.focus === undefined ? {} : { focus: (args.focus as string).trim() }),
      });
    }
    case "release-lease": {
      if (!isRecord(args) || !exactKeys(args, ["reason"])) throw new TypeError("arguments contain an unknown property");
      if (!nonEmptyString(args.reason)) throw new TypeError("--reason must be a non-empty string");
      return coordinator.releaseLease(args.reason.trim());
    }
  }
}

export function createCliHandler(
  coordinator: CliCoordinator,
  options: CliHandlerOptions,
): BridgeRequestHandler {
  const services = options.services ?? {};
  return async (request) => {
    const command = (CLI_ROUTES as Record<string, CliCommand | undefined>)[request.url.pathname];
    if (command === undefined) return protocolError(404, "not-found", "Route not found");
    if (request.method !== "POST") return protocolError(405, "invalid-request", "This surface accepts POST requests");
    // The token alone is not enough: every aboard terminal inherits it, so a
    // worker could otherwise reach the launch surface by hand. Only the recorded
    // Manager may orchestrate.
    const caller = request.headers[AGENT_ID_HEADER];
    if (caller !== options.managerAgentId) {
      return refusal(403, "not-the-manager", "This command is the Manager's. Only the aboard Manager session may orchestrate the fleet.");
    }
    try {
      return ok(await runCommand(coordinator, services, command, request.body ?? {}, request.signal));
    } catch (error) {
      if (error instanceof TypeError) return refusal(400, "invalid-request", error.message);
      if (error instanceof DelegationError) return refusal(409, error.code, error.message, error.details);
      if (error instanceof GitHubBoundaryError) return refusal(409, error.code, error.message, error.details);
      throw error;
    }
  };
}
