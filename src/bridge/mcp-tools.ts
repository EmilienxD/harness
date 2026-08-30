import {
  BRAINSTORMER_LAUNCHABLE_AGENT_TYPES,
  MCP_DEFAULT_AGENT_TYPE,
  MCP_LAUNCHABLE_AGENT_TYPES,
  type AgentType,
} from "../domain/contracts.js";
import { ROADMAP_TASK_STATUSES } from "../domain/roadmap.js";

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** The server name the Manager's `mcp__aboard__*` tool rules are namespaced by. */
export const ABOARD_MCP_SERVER_NAME = "aboard";

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
    description:
      "Launch one visible, independent, fresh agent session. " +
      "Use this when a coherent unit of work should be delegated " +
      "and the user should be able to watch, interrupt, or take over.\n\n" +

      "## Choosing the agent type\n\n" +
      "`type` is optional and defaults to `general-purpose`, so omit it when no narrower role fits.\n" +
      "- `general-purpose` (default): General-purpose agent for researching complex and specific questions, " +
        "searching for code and executing multi-step tasks, " +
        "for direct coding that may mix investigation and editing. " +
        "This is the path for a fast change, critical fix or any unplanned modification; " +
        "complex or planned implementation goes through `start_auto_run` instead, " +
        "which owns branches, commits, and pull requests. " +
        "It can be automated or handed to the user. " +
        "An instruction addressed to you in the imperative — build this, fix this, change this, try this — " +
        "asks for this launch. It is neither yours to carry out nor an occasion to explain that you do not implement: " +
        "carry the user's own instruction through as the opening `prompt`, " +
        "adding the context they did not have to repeat, " +
        "and pass `interactive: true` when they will want to iterate on the result themselves.\n" +
      "- `Explore`: Read-only search agent for code exploration. " +
        "Use it to get up to date codebase reports. " +
        "Do NOT use it for code review, design-doc auditing — it is not meant to make judgments, it is impartial and only surfaces facts" +
        "When calling, specify search breadth: \"quick\" for a single targeted lookup, \"medium\" for moderate exploration, " +
        "or \"very thorough\" to search across multiple locations and naming conventions.\n" +
      "- `webresearcher`: automated, read-only research for cutoff-sensitive external facts. " +
        "Use for current documentation, versions, pricing, standards, advisories, " +
        "or vendor behavior that may have changed; it returns cited current evidence.\n" +
      "- `brainstormer`: a user-driven conversation that resolves a vague product or architecture idea " +
        "into an implementation-ready durable specification. " +
        "It is interactive only.\n\n" +

      "## When to use or not use\n\n" +
      "If the target is already known, use the direct tool: Read for a known path, " +
      "the Grep tool for a specific symbol or string. " + 
      "Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type." +

      "## Usage\n\n" +
      "- `interactive: true` hands the session to the user. Its report arrives after the user runs `/done`. " +
        "Use it when the work is a conversation the user should be having, not a task. " +
        "The optional `prompt` is its opening topic. " +
        "`brainstormer` and `prototyper` are interactive only; `webresearcher` and `Explore` are automated only and reject `interactive`.\n" +
      "- **Foreground vs background**: Use `run_in_background: false` (default) when you need the agent's results before you can proceed — " +
        "e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel." +
      "- Give each launch a distinct 3-6 word `description`, such as \"Audit retry logic centralization\".\n" +
      "- Send independent launches as multiple tool calls in one message when they should run concurrently.\n" +
      "- Summarize an automated result for the user. For coding work, check actual edits and validation before reporting completion.\n\n" +

      "## Prompt and issues\n\n" +
      "Automated launches require a self-contained `prompt`; interactive launches may omit it. " +
      "Include the goal and why it matters, relevant findings or rejected approaches, the bounded task, and the expected output or validation. " +
      "The agent has no access to this conversation. For a lookup, provide the exact command; for an investigation, provide the question rather than guessed steps.\n\n" +
      "Use `issues` to include the GitHub issues an automated agent needs. " +
      "Pass only related issues that fit one agent's task, and always pair `issues` with `prompt`.\n\n" +

      "An automated editing launch may be refused while another automated editor is active. " +
      "Surface the returned conflict instead of retrying or queueing.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: MCP_LAUNCHABLE_AGENT_TYPES,
          default: MCP_DEFAULT_AGENT_TYPE,
          description: `Agent role; defaults to \`${MCP_DEFAULT_AGENT_TYPE}\` when omitted.`,
        },
        prompt: {
          type: "string",
          minLength: 1,
          description: "Self-contained opening message for the agent.",
        },
        description: {
          type: "string",
          minLength: 1,
          description: "A distinct 3-6 word label, e.g. 'Audit retry logic centralization'.",
        },
        issues: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "integer", minimum: 1 },
          description: "GitHub issue numbers whose context the agent needs.",
        },
        interactive: {
          type: "boolean",
          description: "Hand the session to the user instead of waiting for an automated result; false by default.",
        },
        run_in_background: {
          type: "boolean",
          description: "Return immediately from an automated launch; false waits for the result.",
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_create",
    description:
      "Add one or more high-level tasks to the project's durable roadmap. " +
      "Use this only for newly identified project work or priorities; implementation details belong in the issue that carries the work. " +
      "Send related subjects together in priority order. Each subject must be a directional single line of at most 200 characters " +
      "with no leading list or heading markup. If any subject is invalid, no tasks are added.\n\n" +

      "Omit `after` to append, use `after: 'top'` for highest priority, or provide a current task position to insert immediately after it.\n\n" +

      "An insertion can renumber later tasks. When the result includes `tasks`, treat that as the current roadmap and discard older positions.\n\n" +

      "Never issue this call alongside another roadmap write in the same message. " +
      "Batch creations in one call, and make later writes against the preceding result.",
    inputSchema: {
      type: "object",
      properties: {
        subjects: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1, maxLength: 200 },
          description: "New task subjects, in priority order. Each must be a single directional line with no leading list or heading markup.",
        },
        after: ANCHOR_SCHEMA(
          "Placement anchor. Omit to append, 'top' for highest priority, or a task position to insert the batch after.",
        ),
      },
      required: ["subjects"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_update",
    description:
      "Update exactly one existing roadmap task, addressed by its position in the newest roadmap block in your context. " +
      "Use this to retitle a task, change its completion status, reprioritize it, or delete it on the user's explicit request. " +
      "Provide at least one of `subject`, `status`, or `after`.\n\n" +

      "Set `task` to the shown 1-based position. Set `expect` to the current subject, or at least its first 40 characters, copied exactly. " +
      "Positions are absolute over the whole roadmap, so use the displayed number even when pending positions have gaps. " +
      "If the position or subject no longer matches, use the returned current list before retrying.\n\n" +

      "`pending` marks remaining work, `completed` checks the task without moving it, and `deleted` removes it. " +
      "Use `deleted` only when the user explicitly asks for deletion. There is no in-progress status.\n\n" +

      "Use `after: 'top'` to move the task first or a current position to move it after that task. " +
      "A move or deletion can renumber other tasks. When the result includes `tasks`, treat that as the current roadmap and discard older positions.\n\n" +

      "A replacement subject follows the same single-line, 200-character, no-leading-markup rules as creation. " +
      "Retitling does not change the task's position.\n\n" +

      "Never issue this call alongside another roadmap write in the same message. " +
      "Send writes one at a time, each addressed against the result of the last.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "integer",
          minimum: 1,
          description: "1-based position of the task to change, read from the newest roadmap block in your context.",
        },
        expect: {
          type: "string",
          minLength: 1,
          description:
            "The task's current subject, or at least its first 40 characters, copied exactly. " +
            "Confirms this position still holds the task you mean.",
        },
        subject: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Replacement subject: one directional line with no leading list or heading markup. Leaves the task's position unchanged.",
        },
        status: {
          type: "string",
          enum: ROADMAP_TASK_STATUSES,
          description: "New status. Use deleted only when the user explicitly requests deletion; there is no in-progress status.",
        },
        after: ANCHOR_SCHEMA(
          "Reprioritization anchor: 'top' to move before the first task, or a task position to move after. " +
          "Anchoring to the task's own position is a no-op.",
        ),
      },
      required: ["task", "expect"],
      additionalProperties: false,
    },
  },
  {
    name: "start_auto_run",
    description:
      "Start implementation of all eligible open issues labelled `[AI]-afk` or `[AI]-hitl`, with dependencies first. " +
      "Use this only after the user has approved the work and the issues are ready to address. " +
      "Use `run_agent` only for fast or unplanned changes, not to bypass this issue workflow.\n\n" +

      "The call is non-blocking. On refusal, relay the returned reason, especially dirty paths; " +
      "do not alter unrelated work or guess how to resolve a failed precondition.\n\n" +

      "On success it returns the frozen issue order and any skipped issues with reasons. " +
      "Report that plan and continue the conversation; do not wait or poll. " +
      "Calling again while a run is active returns that run instead of starting another.\n\n" +

      "`[AI]-afk` issues may proceed without user review. `[AI]-hitl` issues wait for user review and merge. " +
      "A failure stops the run for inspection instead of skipping the issue. " +
      "The run drains the queue, so use `aboard.autoRun.pauseAfterHitl` or stop it from the palette if the user wants a smaller batch. " +
      "Do not say work has landed on the user's branch until the run pull request is merged.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "review_pr",
    description:
      "Open an interactive session for the user to inspect or continue work on an existing pull request. " +
      "Use this when the user asks to review, inspect, discuss, or continue work on a pull request. " +
      "The tool itself does not review, comment, approve, merge, or return a later agent result.\n\n" +

      "Omit `pr` to select the latest open pull request, or provide its number. " +
      "Use `focus` for the topic the user wants inspected. It may be returned as `unusedFocus` when an existing session is resumed " +
      "and cannot accept a new opening prompt. If no matching open pull request exists, nothing is launched.",
    inputSchema: {
      type: "object",
      properties: {
        pr: {
          type: "integer",
          minimum: 1,
          description: "Pull-request number to target. Omit to use the latest open pull request.",
        },
        focus: {
          type: "string",
          minLength: 1,
          description: "Topic the user wants inspected. The result reports when an existing session could not apply it.",
        },
      },
      additionalProperties: false,
    },
  },
];

const BRAINSTORMER_RUN_AGENT: McpTool = {
  name: "run_agent",
  description:
    "Launch a visible research or prototyping session when the brainstorm needs evidence before it can settle a claim. " +
    "Use `Explore` for read-only repository facts, `webresearcher` for current external facts with citations, and `prototyper` for an experiment the user will direct. " +
    "Explore and web research run independently and report back here; a prototyper opens as an interactive terminal and reports when the user runs `/done`. " +
    "Give the new session a self-contained prompt because it cannot see this conversation.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: BRAINSTORMER_LAUNCHABLE_AGENT_TYPES,
        description: "Evidence-gathering role to launch.",
      },
      prompt: {
        type: "string",
        minLength: 1,
        description: "Self-contained question or experiment for the new session.",
      },
      description: {
        type: "string",
        minLength: 1,
        description: "A distinct 3-6 word label for the visible terminal.",
      },
    },
    required: ["type", "prompt", "description"],
    additionalProperties: false,
  },
};

const CONTINUE_AGENT: McpTool = {
  name: "continue_agent",
  description:
    "Reopen a reported prototype or web-research conversation and ask one follow-up question. " +
    "Use the agent id returned by `run_agent` or by a manual `/prototype` notification. " +
    "A session that is still open cannot be continued because its report is still coming.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", minLength: 1, description: "Agent id of the reported session to reopen." },
      prompt: { type: "string", minLength: 1, description: "Self-contained follow-up question." },
    },
    required: ["agent_id", "prompt"],
    additionalProperties: false,
  },
};

export const BRAINSTORMER_MCP_TOOLS: readonly McpTool[] = [BRAINSTORMER_RUN_AGENT, CONTINUE_AGENT];

export const MCP_TOOL_CATALOGS: Readonly<Partial<Record<AgentType, readonly McpTool[]>>> = {
  manager: CORE_MCP_TOOLS,
  brainstormer: BRAINSTORMER_MCP_TOOLS,
};

export function mcpToolsForRole(type: AgentType): readonly McpTool[] | undefined {
  return MCP_TOOL_CATALOGS[type];
}

export function aboardToolNamesForRole(type: AgentType): readonly string[] {
  return (mcpToolsForRole(type) ?? []).map((tool) => `mcp__${ABOARD_MCP_SERVER_NAME}__${tool.name}`);
}

export const MANAGER_TOOL_NAMES: readonly string[] = aboardToolNamesForRole("manager");
