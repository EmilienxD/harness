import { MCP_LAUNCHABLE_AGENT_TYPES, isAutomatedAgentType, isInteractiveAgentType, type AgentId, type AgentType } from "../domain/contracts.js";
import { ROADMAP_TASK_STATUSES, type RoadmapAnchor, type RoadmapTaskStatus } from "../domain/roadmap.js";
import { GitHubBoundaryError, type GitHubClient } from "../github/client.js";
import type { ReviewCoordinator } from "../github/review.js";
import { DelegationCoordinator, DelegationError, type DelegationLaunchInput } from "./delegation.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";

const MCP_PROTOCOL_VERSION = "2025-03-26";
export const ABOARD_MCP_TIMEOUT_SECONDS = 3600;
export const ABOARD_MCP_TOOL_PATTERN = "mcp__aboard__*";

/** The MCP registration expands this from each Claude session's environment. */
const AGENT_ID_HEADER = "x-aboard-agent-id";

type JsonRpcId = string | number | null;

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const LAUNCH_PROPERTIES = {
  type: {
    type: "string",
    enum: MCP_LAUNCHABLE_AGENT_TYPES,
    description:
      "Agent role. " +
      "Use general-purpose for direct full-tool work, Explore for read-only repository search, " +
      "brainstormer for a user-driven product or architecture conversation, " +
      "and webresearcher for current external facts with citations. " +
      "Implementation roles are intentionally unavailable here; use start_auto_run for issue implementation.",
  },
  prompt: {
    type: "string",
    minLength: 1,
    description:
      "The agent's complete opening task and first user turn. " +
      "Required for automated launches. " +
      "For interactive launches, omit it unless the user explicitly supplied an opening topic; " +
      "never invent or paraphrase one merely to fill this field.",
  },
  description: {
    type: "string",
    minLength: 1,
    description:
      "Required concise 3-6 word label shown to the user in the fleet tree. " +
      "Describe the concrete purpose, such as 'Audit retry logic centralization', " +
      "rather than a generic label such as 'Investigate code'.",
  },
  issue: {
    type: "integer",
    minimum: 1,
    description:
      "Optional positive GitHub issue number. " +
      "When present, aboard resolves the issue and parent specification " +
      "and merges that contract into the opening prompt; " +
      "do not spend an agent turn fetching launch-contract material again.",
  },
  interactive: {
    type: "boolean",
    description:
      "Defaults to false. " +
      "Set true only when the user should drive the terminal directly. " +
      "The terminal is focused and no result is delivered back to the caller, " +
      "so continue with the user and never wait, poll, or promise a later summary. " +
      "brainstormer is always interactive; webresearcher cannot be interactive.",
  },
  run_in_background: {
    type: "boolean",
    description:
      "Applies only to automated launches. " +
      "Defaults to false, which blocks until the final result is needed for the current decision. " +
      "Set true only for independent work that may finish later; " +
      "the call returns immediately and completion is delivered as a later notification. " +
      "Ignored with a notice when interactive is true.",
  },
} as const;

const RUN_AGENT_DESCRIPTION = 
  "Launch one visible, independent Claude Code session in a real terminal created by aboard. " +
  "Use this when a coherent unit of work should be delegated " +
  "and the user should be able to watch, interrupt, or take over. " +
  "Do not use it for one known-file read, one targeted symbol lookup, " +
  "or to fetch roadmap, fleet, issue, pull-request, or git state already supplied in context.\n\n" +

  "Choose the role deliberately:\n" +
  "- general-purpose: Claude Code's unmodified default full-tool session, " +
  "for direct work that may mix investigation and editing. " +
  "It can be automated or handed to the user.\n" +
  "- Explore: Claude Code's built-in read-only repository search role. " +
  "Use for locating files, references, patterns, or answering where code lives. " +
  "State quick, medium, or very thorough breadth in the prompt. " +
  "It can be automated or handed to the user.\n" +
  "- brainstormer: a user-driven conversation that resolves a vague product or architecture idea " +
  "into an implementation-ready durable specification. " +
  "It is interactive only.\n" +
  "- webresearcher: automated, read-only research for cutoff-sensitive external facts. " +
  "Use for current documentation, versions, pricing, standards, advisories, " +
  "or vendor behavior that may have changed; it returns cited current evidence.\n" +
  "Implementation agents and pull-request doctors are not available through this tool. " +
  "Use start_auto_run for approved issue implementation " +
  "and review_pr to hand an existing pull-request session back to the user.\n\n" +

  "Mode and delivery are separate decisions. " +
  "An interactive launch focuses the terminal for the user and never returns an agent result. " +
  "An automated foreground launch waits for the final result " +
  "when that answer is required before making the next recommendation. " +
  "run_in_background returns immediately and should be used only when the work is independent; " +
  "its eventual result arrives through a later notification. " +
  "Every launch starts a fresh conversation with no knowledge of the Manager's conversation.\n\n" +

  "Write an automated prompt as a self-sufficient briefing for a capable colleague entering cold: " +
  "state the goal and why it matters, relevant files and constraints, " +
  "known facts and rejected approaches, the exact question or bounded task, " +
  "and what output or validation proves completion. " +
  'Do not delegate synthesis with vague instructions such as "investigate and do the right thing." ' +
  "Ask for a concise result when appropriate.\n\n" +

  "Automated write-capable launches participate in the single-writer lease. " +
  "If another writer holds it, the call fails immediately with holder details; " +
  "surface that conflict instead of retrying or queueing. " +
  "Read-only and interactive sessions may run concurrently " +
  "because interactive overlap is the user's decision.";

const TODO_CREATE_DESCRIPTION = 
  "Add one or more new tasks to the project's durable roadmap, " +
  "which is a flat checkbox list on the GitHub issue labelled ai:todo. " +
  "Use this only to record newly identified project-level work or priorities; " +
  "implementation detail belongs in an ai:spec issue. " +
  "The current roadmap is supplied in context, " +
  "so there is deliberately no roadmap read tool and no full-body replacement operation.\n\n" +

  "Send all related new subjects in one call. " +
  "The batch is atomic, preserves the supplied order, and costs one GitHub issue edit. " +
  "Each subject must be a directional single line of at most 200 characters " +
  "with no leading list or heading markup. " +
  "If any subject is invalid, nothing is written.\n\n" +

  "Placement is explicit: omit after to append, " +
  "use after='top' to make the batch highest priority, " +
  "or pass a current task position to place the batch immediately after that task. " +
  "If no roadmap issue exists, this tool creates the first one. " +
  "It returns positions, the new tasks' positions in subject order, and the roadmap issue number.\n\n" +

  "Inserting anywhere but the end renumbers every task after the insertion point. " +
  "When that happens the result also carries tasks, the pending list as it now stands; " +
  "use it and discard the positions you were holding. " +
  "A plain append renumbers nothing and omits that list. " +
  "Multiple roadmap carriers are reported but never modified or consolidated automatically.";

const TODO_UPDATE_DESCRIPTION =
  "Mutate exactly one existing roadmap task, addressed by its position " +
  "in the newest roadmap block in your context. " +
  "Use this to retitle a task, change its completion status, reprioritize it, " +
  "delete it on the user's explicit request, or combine those changes atomically. " +
  "At least one of subject, status, or after is required.\n\n" +

  "Addressing takes two fields and both are required. " +
  "task is the 1-based position shown against the task. " +
  "expect is that task's current subject, or at least its first 40 characters, copied not paraphrased. " +
  "The position says which line to change and expect proves you are looking at the task you mean, " +
  "so a roadmap the user edited on GitHub in the meantime cannot silently take the write. " +
  "Positions are absolute over the whole roadmap and identical in the full and pending renderings, " +
  "so a pending list showing 4, 9, 12 means exactly those numbers. " +
  "A position that does not exist, or an expect that does not match, " +
  "writes nothing and returns the current list; retry against that list.\n\n" +

  "Status semantics: pending marks remaining work; " +
  "completed changes the checkbox to complete but leaves the task in its current position forever; " +
  "deleted removes the task and must be used only when the user explicitly asks for deletion. " +
  "in_progress is accepted but coerced to pending with a notice " +
  "because live work is already derived from issues, pull requests, and auto-run state.\n\n" +

  "Reprioritize with after='top' or after=<current position>; " +
  "moving is part of this update, not a separate operation. " +
  "after takes no confirmation of its own: a wrong anchor only misplaces the task in the order, " +
  "which the next roadmap block shows plainly. " +
  "A move or a deletion renumbers other tasks, so the result then carries tasks, " +
  "the pending list as it now stands; use it and discard the positions you were holding. " +
  "A status or subject change in place renumbers nothing and omits that list.\n\n" +

  "A replacement subject follows the same single-line, 200-character, no-leading-markup rules as creation. " +
  "Retitling does not change the task's position. " +
  "Non-checkbox roadmap text and all unrelated tasks remain untouched.";

const START_AUTO_RUN_DESCRIPTION = 
  "Start aboard's automatic implementation workflow for the oldest open ai:spec issue. " +
  "Use this only after the user has approved implementation " +
  "and the specification and child issues are ready. " +
  "Do not use run_agent to bypass this workflow: " +
  "the extension, not an agent, owns branch creation, commits, pushes, " +
  "pull requests, optional review launches, merges, and cleanup.\n\n" +

  "The call is non-blocking and takes no inputs. " +
  "It validates that no run is active, the repository and GitHub authentication are usable, " +
  "the working tree is clean, an open specification exists, " +
  "and that specification has at least one processable child. " +
  "The first failed precondition launches nothing; relay its reason verbatim, especially dirty paths, " +
  "because only the user may decide what to do with unrelated work.\n\n" +

  "On success it immediately returns the run id, selected specification, " +
  "forecast issue order, dispositions, branch names, and skips with reasons. " +
  "Report that plan and continue the conversation; do not wait or poll. " +
  "Calling again while a run is active returns the current run instead of creating a second one. " +
  "Progress is delivered later through bounded notifications.\n\n" +

  "Issues are processed serially and re-derived from GitHub at each boundary. " +
  "ai:afk work may merge automatically. " +
  "ai:hitl work waits at its pull request until the user merges it; " +
  "that merge is the approval and normally resumes the run. " +
  "A failure stops the run rather than skipping to siblings, " +
  "leaving visible work in place for inspection.";

const REVIEW_PR_DESCRIPTION = 
  "Hand an existing open pull request's owning aboard session back to the user " +
  "for interactive inspection or follow-up. " +
  "Use this when the user asks to review, inspect, discuss, or continue work on a pull request. " +
  "This does not perform a review, launch an automated reviewer, post comments, " +
  "approve, merge, or return a later agent result.\n\n" +

  "Omit pr to select the latest open pull request, " +
  "or provide a positive pull-request number to target one explicitly. " +
  "The optional focus text names what the user wants to inspect. " +
  "It steers the first pass only when aboard must create a fallback session; " +
  "an existing session is already loaded and cannot be steered, " +
  "so the focus is returned as unusedFocus instead of being applied. " +
  "If the owning implementer or pull-request doctor is live, its terminal is focused; " +
  "if its recorded session is closed, it is resumed with its original restrictions. " +
  "If ownership is unavailable after a restart, " +
  "aboard opens a fresh interactive pull-request doctor and reports that fallback. " +
  "If no matching open pull request exists, nothing is launched.";

/**
 * `after` names either a task position or the top of the list. The two-branch
 * schema keeps the anchor a real integer rather than a stringly-typed position,
 * and the string case uses `enum` rather than `const` because more MCP clients
 * support it. Runtime validation in `parseAfter` remains authoritative.
 */
function ANCHOR_SCHEMA(description: string): Readonly<Record<string, unknown>> {
  return {
    oneOf: [
      { type: "integer", minimum: 1 },
      { type: "string", enum: ["top"] },
    ],
    description,
  };
}

export const CORE_MCP_TOOLS: readonly McpTool[] = [
  {
    name: "run_agent",
    description: RUN_AGENT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: LAUNCH_PROPERTIES,
      required: ["type", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_create",
    description: TODO_CREATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        subjects: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1, maxLength: 200 },
          description:
            "Required non-empty batch of directional task subjects. " +
            "Each subject must be one line, at most 200 characters, " +
            "and must not begin with list or heading markup. " +
            "The batch is atomic and inserted in this order.",
        },
        after: ANCHOR_SCHEMA(
          "Optional placement anchor. " +
          "Omit to append after every current task, use 'top' to insert before the first task, " +
          "or provide a current 1-based task position " +
          "to insert the whole batch immediately after that task.",
        ),
      },
      required: ["subjects"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_update",
    description: TODO_UPDATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "integer",
          minimum: 1,
          description:
            "Required 1-based position of the task, read from the newest roadmap block in your context. " +
            "A position that does not exist fails without writing and returns the current task list.",
        },
        expect: {
          type: "string",
          minLength: 1,
          description:
            "Required confirmation that this position still holds the task you mean: " +
            "its current subject, or at least its first 40 characters, copied exactly. " +
            "Whitespace is normalized before comparison; a mismatch writes nothing " +
            "and returns the current task list.",
        },
        subject: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional replacement subject: one directional line of at most 200 characters " +
            "with no leading list or heading markup. " +
            "Retitling leaves the task's position unchanged.",
        },
        status: {
          type: "string",
          enum: [...ROADMAP_TASK_STATUSES, "in_progress"],
          description:
            "Optional status. " +
            "pending reopens remaining work; completed checks the task in place permanently; " +
            "deleted removes it and is allowed only on the user's explicit request; " +
            "in_progress is coerced to pending because live state is derived elsewhere.",
        },
        after: ANCHOR_SCHEMA(
          "Optional reprioritization anchor. " +
          "Use 'top' to move before the first task, or a current 1-based task position " +
          "to move immediately after that task. " +
          "Anchoring to the task's own position is a no-op.",
        ),
      },
      required: ["task", "expect"],
      additionalProperties: false,
    },
  },
  {
    name: "start_auto_run",
    description: START_AUTO_RUN_DESCRIPTION,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "review_pr",
    description: REVIEW_PR_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        pr: {
          type: "integer",
          minimum: 1,
          description:
            "Optional positive pull-request number. " +
            "Omit to use the latest open pull request.",
        },
        focus: {
          type: "string",
          minLength: 1,
          description:
            "Optional concise topic naming what the user wants to inspect or discuss. " +
            "Used as the opening handoff context when aboard must create a fallback interactive session; " +
            "otherwise it is returned as unusedFocus and the user retypes it in the terminal.",
        },
      },
      additionalProperties: false,
    },
  },
];

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

interface ParsedLaunch {
  readonly input: DelegationLaunchInput;
  readonly interactive: boolean;
  readonly background: boolean;
  readonly notices: readonly string[];
}

function parseLaunch(value: unknown): ParsedLaunch | string {
  if (!isRecord(value)) return "arguments must be an object";
  if (!exactKeys(value, ["type", "prompt", "description", "issue", "interactive", "run_in_background"])) {
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
  const words = value.description.trim().split(/\s+/).length;
  if (words < 3 || words > 6) return "description must contain 3-6 words";
  if (value.prompt !== undefined && !nonEmptyString(value.prompt)) return "prompt must be non-empty when provided";
  if (value.issue !== undefined && (!Number.isInteger(value.issue) || (value.issue as number) <= 0)) return "issue must be a positive integer";

  const notices: string[] = [];
  let interactive = value.interactive === true;
  if (!interactive && isInteractiveAgentType(type)) {
    interactive = true;
    notices.push(`${type} is an interactive type and was launched interactively; no result will be delivered, so continue with the user instead of waiting.`);
  }
  if (!interactive && !nonEmptyString(value.prompt)) return "prompt is required unless interactive is true";
  const background = !interactive && value.run_in_background === true;
  if (interactive && value.run_in_background === true) {
    notices.push("run_in_background was ignored: an interactive session returns no result to wait for.");
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
  if (value === "in_progress") {
    return {
      value: "pending",
      notices: [
        "status in_progress was recorded as pending: the roadmap tracks what is left to do, " +
        "and what is in flight is already in the issues, pull requests, " +
        "and auto-run state your briefing carries.",
      ],
    };
  }
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
      return refusal(403, "not-the-manager", "This MCP server is the Manager's. Only the aboard Manager session may orchestrate the fleet.");
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
          instructions: "Use aboard tools to launch visible Claude Code terminals, evolve the roadmap, start auto-runs, and reopen pull-request sessions.",
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
