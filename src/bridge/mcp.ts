import { MCP_LAUNCHABLE_AGENT_TYPES, isAutomatedAgentType, isInteractiveAgentType, type AgentType } from "../domain/contracts.js";
import { DelegationCoordinator, DelegationError, type DelegationLaunchInput } from "./delegation.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";
import { GitHubBoundaryError, type GitHubClient } from "../github/client.js";
import type { ReviewCoordinator } from "../github/review.js";

const MCP_PROTOCOL_VERSION = "2025-03-26";
/**
 * The bound a foreground delegation runs under, matching the Manager Stop hook
 * timeout (`docs/auto-implementation.md` §111). It is operator configuration —
 * `ABOARD_MCP_TIMEOUT` — so it is documented here rather than served to the
 * model as MCP `instructions`, which no agent can act on.
 */
export const ABOARD_MCP_TIMEOUT_SECONDS = 3600;

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

// One launch tool with two orthogonal flags, not one tool per combination. Both
// flags carry information no other argument supplies: `interactive` decides
// whether a result exists at all, `run_in_background` decides when it arrives.
// The shape and wording track Claude Code's own `Agent` tool so the Manager
// brings the same priors to it (spec section 6.1).
const LAUNCH_PROPERTIES = {
  type: { type: "string", enum: MCP_LAUNCHABLE_AGENT_TYPES },
  prompt: {
    type: "string",
    minLength: 1,
    description: "The task for the agent; becomes its first user turn. Required unless interactive is true, where it is an optional opening topic that should usually be omitted.",
  },
  description: { type: "string", minLength: 1, description: "A concise 3-6 word description shown in the fleet tree." },
  issue: { type: "integer", minimum: 1, description: "Optional GitHub issue whose resolved contract is merged into the launch prompt." },
  interactive: {
    type: "boolean",
    description: "Set to true to hand the terminal to the user to drive. No result is ever delivered for an interactive agent. Defaults to false.",
  },
  run_in_background: {
    type: "boolean",
    description: "Set to true to run this agent in the background. You will be notified when it completes. Defaults to false, which blocks this call until the agent's final message is available. Ignored when interactive is true, which has no result to wait for.",
  },
} as const;

const RUN_AGENT_DESCRIPTION = `Launch a visible, independent Claude Code agent in its own terminal. This is aboard's replacement for Claude Code's Agent tool: the agent is a real session the user can watch, interrupt, and take over, not an in-process subagent.

Available agent types:
- general-purpose: Claude Code's built-in full-tool agent for multi-step work that mixes exploring and editing. Runs in either mode.
- Explore: Claude Code's built-in read-only search agent. Use it to find files by pattern (eg. "src/**/*.test.ts"), grep for symbols or keywords, or answer "where is X defined / which files reference Y". Do NOT use it for code review, design auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. State the breadth you want in the prompt: "quick" for a single targeted lookup, "medium" for moderate exploration, "very thorough" to search across multiple locations and naming conventions. Read-only, so it never holds the write lease. Runs in either mode.
- brainstormer: Develop a product or architecture idea with the user and finish with a durable spec. Interactive only.
- webresearcher: Research current external facts from authoritative web sources and return a concise answer with citations. Automated and read-only; use it when the answer may have changed since your knowledge cutoff.
- raw: An unconstrained Claude Code session with no agent definition, for a user who wants to work directly. Interactive only.

To get an issue implemented, call mcp__aboard__start_auto_run. Implementation agents are not launchable here.

## Two modes

**Interactive** (\`interactive: true\`) focuses the terminal and hands it to the user, who drives it from there. **No result is ever delivered** — never wait for one, never poll for one, and never tell the user you will report back. Hand off and continue the conversation. \`prompt\` is optional here and should be omitted unless the user named a specific topic to open on; they type the first message themselves. Never invent or paraphrase a topic to fill it in: an invented opening turn spends the agent's first turn on a question the user did not ask.

**Automated** (the default) has the agent work alone and report back, and requires a \`prompt\`. \`webresearcher\` is always used this way. \`brainstormer\` and \`raw\` exist only to be handed to the user, so requesting either without \`interactive: true\` launches interactively anyway and says so in the result.

**Foreground vs background**: foreground (the default) blocks this call until the agent's final message is available — use it when you need the result before you can say anything useful, such as research that decides what you recommend next. \`run_in_background: true\` returns immediately and notifies you on completion — use it for genuinely independent work, or when the user is mid-conversation and should not be left waiting on a tool call.

## When not to use

If the target is already known, use the direct tool: Read for a known path, Grep for a specific symbol. The project roadmap, git state, open issues, and fleet are already in your context at session start — never launch an agent to fetch them, and never launch one to read a file you can name. Hand over a coherent unit of work: a question that needs searching to answer, a task with real steps, one conversation the user wants to have. Not a single lookup.

## Usage notes

- Always include a short description. It names the agent's terminal in the fleet tree and is what the user reads to know what is running, so "Audit retry centralization" beats "Investigate code".
- When you launch several independent agents, send them in a single message so they run concurrently.
- The user can watch the terminal, but the agent's returned result is not shown to them. Relay what matters in your own words.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual change before reporting the work as done.
- Neither flag bypasses the single-writer lease. At most one write-capable agent runs at a time; a second launch fails immediately with the current holder rather than queuing, and you should surface that to the user instead of retrying. Read-only agents stay concurrent.
- Every call starts a fresh agent with no memory of prior runs and no view of this conversation.

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it has not seen this conversation, does not know what the user asked, and does not know why the task matters.

- Say what you are trying to accomplish, and why.
- Name what you already know: the files you suspect, what you have ruled out, the constraint that makes the obvious answer wrong.
- Give enough surrounding context that the agent can make judgement calls rather than following a narrow instruction off a cliff.
- Lookups: hand over the exact path or command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- Say what "done" looks like, and name the command that proves it.
- If you need a short answer, say so ("report in under 200 words").

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Do not write "based on your findings, fix it" or "investigate and do the right thing" — those push synthesis onto the agent instead of doing it yourself. A prompt that proves you understood names files, symbols, and the specific change you expect.

<example>
user: "I want to think through the caching layer."
assistant: <thinking>This is the user's own thinking to do, not a task to delegate — hand them a brainstormer. They named the topic, so I can open on it, but the first real message is theirs.</thinking>
mcp__aboard__run_agent({
  type: "brainstormer",
  interactive: true,
  description: "Brainstorm the caching layer",
  prompt: "The caching layer"
})
<commentary>
No result will come back. Tell the user the terminal is open and waiting for them, then continue; do not offer to summarize an outcome.
</commentary>
</example>

<example>
user: "Before we start #41, is the retry logic really all in one place like the issue claims?"
assistant: <thinking>A factual question about the codebase that needs real searching, and the answer changes what I recommend next — so foreground, and I hold my recommendation until it lands.</thinking>
mcp__aboard__run_agent({
  type: "Explore",
  description: "Audit retry logic centralization",
  prompt: "Issue #41 assumes every HTTP retry in this repo goes through src/net/retry.ts, and plans a change in that one file. Verify that assumption. Find every retry, backoff, or re-attempt implementation, including ad-hoc loops that re-issue a request on failure without the shared helper. Medium breadth. Report file:line locations and say plainly whether the assumption holds; under 200 words."
})
<commentary>
The prompt states the goal, the belief under test, what counts as a hit, the breadth, and the shape of the answer. Relay the finding to the user before recommending the auto-run.
</commentary>
</example>`;

// Tools are served under bare names; Claude Code namespaces them for the model
// as mcp__aboard__<name>, which the Manager's `tools:` frontmatter matches with
// mcp__aboard__*.
export const CORE_MCP_TOOLS: readonly McpTool[] = [
  {
    name: "run_agent",
    description: RUN_AGENT_DESCRIPTION,
    inputSchema: { type: "object", properties: LAUNCH_PROPERTIES, required: ["type", "description"], additionalProperties: false },
  },
  {
    name: "update_todo",
    description: "Replace the body of the project roadmap issue. The current roadmap is already in your context from session start, so read it there and write the full replacement body — there is no fetch step. Creates the issue on first write when missing. The reason is audit context for the user and is not stored in the issue.",
    inputSchema: { type: "object", properties: { body: { type: "string" }, reason: { type: "string", minLength: 1 } }, required: ["body", "reason"], additionalProperties: false },
  },
  {
    name: "start_auto_run",
    description: `Start the automatic implementation run for the oldest open spec issue. The extension walks that spec's children one at a time and performs every git and GitHub side effect itself — branch, commit, push, pull request, merge.

Returns immediately with the resolved plan: the spec, the issues it will process with their afk/hitl disposition and branch name, and the issues it is skipping and why. **Do not wait for the run and do not poll it.** A run routinely outlives this conversation, and its progress reaches you one line at a time on the user's next message. Report the plan to the user and continue.

Only one run exists at a time; calling this while a run is active returns the active run's state instead of starting a second one. If the run cannot start — a dirty working tree, no open spec, no processable child — it returns \`started: false\` with the reason and launches nothing. Relay that reason verbatim; the dirty-tree case in particular is the user's own uncommitted work and only they can decide what to do with it.

An \`hitl\` issue pauses the run at its pull request and waits for the user to merge it. That is the design, not a stall: tell the user which pull request is waiting, and that merging it resumes the run.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "review_pr",
    description: `Reopen the aboard session that owns the pull request currently in flight, and hand it to the user. This does not launch a reviewer and posts no review comments: it focuses the terminal of the agent that built the change — the implementer, or the pr-doctor when review mode is on — or resumes that session if its terminal was closed.

This is a handoff, so **no result is delivered**. The user reads what the agent did and continues from there themselves. If no pull request is open, nothing is launched and the tool says so.

Pass \`pr\` only to target a specific pull request; omitted, it picks the latest open one.`,
    inputSchema: { type: "object", properties: { pr: { type: "integer", minimum: 1 }, focus: { type: "string", minLength: 1 } }, additionalProperties: false },
  },
  {
    name: "release_lease",
    description: "Force-release the workspace write lease as an explicit escape hatch. Always provide a meaningful audit reason; concurrent editing may become possible immediately.",
    inputSchema: { type: "object", properties: { reason: { type: "string", minLength: 1 } }, required: ["reason"], additionalProperties: false },
  },
];

export interface AutoRunTrigger {
  start(): Promise<unknown>;
}

export interface McpServices {
  readonly github?: GitHubClient;
  readonly reviews?: ReviewCoordinator;
  readonly autoRun?: AutoRunTrigger;
}

export type McpCoordinator = Pick<DelegationCoordinator,
  "run" | "spawn" | "spawnInteractive" | "releaseLease">;

type JsonRpcId = string | number | null;

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
  const text = JSON.stringify(value);
  return { content: [{ type: "text", text }], structuredContent: value, ...(isError ? { isError: true } : {}) };
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
  // The enum in the schema is advisory; the parser is what actually keeps the
  // implementation types out of the Manager's reach.
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
  if (value.prompt !== undefined && !nonEmptyString(value.prompt)) return "prompt must be a non-empty string when provided";
  if (value.issue !== undefined && (!Number.isInteger(value.issue) || (value.issue as number) <= 0)) return "issue must be a positive integer";

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
  if (!interactive && !nonEmptyString(value.prompt)) return "prompt must be a non-empty string unless interactive is true";
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

/** Notices ride back with the launch result; a coerced call must not look clean. */
function withNotices(result: unknown, notices: readonly string[]): unknown {
  if (notices.length === 0 || !isRecord(result)) return result;
  return { ...result, notice: notices.join(" ") };
}

function parseReason(value: unknown): { readonly reason: string } | string {
  if (!isRecord(value)) return "arguments must be an object";
  if (!exactKeys(value, ["reason"])) return "arguments contain an unknown property";
  if (!nonEmptyString(value.reason)) return "reason must be a non-empty string";
  return { reason: value.reason.trim() };
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
    case "update_todo": {
      if (!isRecord(args) || !exactKeys(args, ["body", "reason"])) throw new TypeError("arguments contain an unknown property");
      if (typeof args.body !== "string") throw new TypeError("body must be a string");
      if (!nonEmptyString(args.reason)) throw new TypeError("reason must be a non-empty string");
      if (services.github === undefined) throw new GitHubBoundaryError("command-failed", "GitHub service is unavailable");
      return services.github.updateTodo(args.body);
    }
    case "start_auto_run": {
      if (!isRecord(args) || !exactKeys(args, [])) throw new TypeError("arguments must be an empty object");
      if (services.autoRun === undefined) throw new GitHubBoundaryError("command-failed", "The auto-run engine is unavailable");
      // Non-blocking: a multi-issue run exceeds the foreground MCP timeout, and
      // blocking would pin the Manager's turn for the whole run.
      return services.autoRun.start();
    }
    case "review_pr": {
      if (!isRecord(args) || !exactKeys(args, ["pr", "focus"])) throw new TypeError("arguments contain an unknown property");
      if (args.pr !== undefined && (!Number.isInteger(args.pr) || (args.pr as number) <= 0)) throw new TypeError("pr must be a positive integer when provided");
      if (args.focus !== undefined && !nonEmptyString(args.focus)) throw new TypeError("focus must be a non-empty string when provided");
      if (services.reviews === undefined) throw new GitHubBoundaryError("command-failed", "Review service is unavailable");
      return services.reviews.review({
        ...(args.pr === undefined ? {} : { pr: args.pr as number }),
        ...(args.focus === undefined ? {} : { focus: (args.focus as string).trim() }),
      });
    }
    case "release_lease": {
      const parsed = parseReason(args);
      if (typeof parsed === "string") throw new TypeError(parsed);
      return coordinator.releaseLease(parsed.reason);
    }
    default:
      throw new DelegationError("unknown-agent", `Unknown MCP tool ${name}`);
  }
}

export function createMcpHandler(coordinator: McpCoordinator, services: McpServices = {}): BridgeRequestHandler {
  return async (request) => {
    if (request.url.pathname !== "/mcp") return protocolError(404, "not-found", "Route not found");
    if (request.method === "GET") return protocolError(405, "invalid-request", "This stateless MCP endpoint accepts POST requests");
    if (request.method !== "POST") return protocolError(405, "invalid-request", "Method not allowed");
    if (!isRecord(request.body) || request.body.jsonrpc !== "2.0" || !(typeof request.body.method === "string")) {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const id = (typeof request.body.id === "string" || typeof request.body.id === "number" || request.body.id === null)
      ? request.body.id
      : null;
    const params = request.body.params;
    switch (request.body.method) {
      case "initialize":
        return jsonRpc(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "aboard", version: "0.0.0" },
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
