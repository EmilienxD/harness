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
        "Use it to get up-to-date codebase reports. " +
        "Do NOT use it for code review or design-doc auditing — it is not meant to make judgments; it is impartial and only surfaces facts. " +
        "When calling, specify search breadth: \"quick\" for a single targeted lookup, \"medium\" for moderate exploration, " +
        "or \"very thorough\" to search across multiple locations and naming conventions.\n" +
      "- `webresearcher`: automated, read-only research for cutoff-sensitive external facts. " +
        "Use for current documentation, versions, pricing, standards, advisories, " +
        "or vendor behavior that may have changed; it returns cited current evidence.\n" +
      "- `brainstormer`: a user-driven conversation that resolves a vague product or architecture idea " +
        "into an implementation-ready durable specification. " +
        "It is interactive only.\n" +
      "- `prototyper`: a throwaway experiment in the project's own prototype location, asking the user where to write when the project defines none. " +
        "It can run independently or as a user-driven interactive session.\n\n" +

      "## When to use or not use\n\n" +
      "If the target is already known, use the direct tool: Read for a known path, " +
      "the Grep tool for a specific symbol or string. " + 
      "Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.\n\n" +

      "## Usage\n\n" +
      "- Always include a short description summarizing what the agent will do.\n" +
      "- `interactive: true` hands the session to the user. Its report arrives after the user runs `/done`. " +
        "Use it when the work is a conversation the user should be having, not a task. " +
        "The optional `prompt` is its opening topic. " +
        "`brainstormer` is interactive only; `webresearcher` and `Explore` are automated only and reject `interactive`. " +
        "`prototyper` can be automated or interactive. If an automated prototyper finds no project-defined location, " +
        "it returns without writing so you can ask the user where the prototype should live.\n" +
      "- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — " +
        "e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel. " +
        "When an agent runs in the background, you will be automatically notified when it completes — " +
        "do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.\n" +
      "- When you launch multiple agents for independent work, send them in a single message " +
        "with multiple tool uses so they run concurrently. " +
        "If the user asks for agents \"in parallel\", you MUST send one message with several `run_agent` calls in it.\n" +
      "- Summarize an automated result for the user. For coding work, check actual edits and validation before reporting completion.\n\n" +

      "## Writing the prompt\n\n" +
      "`prompt` is the agent's opening message. It is required for an automated launch; " +
      "for an interactive one, omit it unless the user gave an explicit opening topic.\n\n" +
      "Brief the agent like a smart colleague who just walked into the room — " +
      "it has not seen this conversation, does not know what you have tried, does not understand why this task matters.\n" +
      "- Explain what you are trying to accomplish and why.\n" +
      "- Describe what you have already learned or ruled out, including rejected approaches.\n" +
      "- Give enough context about the surrounding problem that the agent can make judgment calls " +
        "rather than just following a narrow instruction.\n" +
      "- Name the exact question or bounded task, and what output or validation proves completion.\n" +
      "- If you need a short response, say so (\"report in under 200 words\").\n" +
      "- Lookups: hand over the exact command. Investigations: hand over the question — " +
        "prescribed steps become dead weight when the premise is wrong.\n\n" +
      "Terse command-style prompts produce shallow, generic work. " +
      "Never delegate understanding: do not write \"based on your findings, fix the bug\" " +
      "or \"based on the research, implement it.\" " +
      "Those phrases push synthesis onto the agent instead of doing it yourself. " +
      "Write prompts that prove you understood — what specifically to change.\n\n" +

      "<example>\n" +
      "user: \"What's left on this branch before we can ship?\"\n" +
      "assistant: A survey question across git state, tests, and config. " +
      "Delegate it and ask for a short report so the raw command output stays out of the Manager's context.\n" +
      "run_agent({\n" +
      "  description: \"Audit branch ship readiness\",\n" +
      "  prompt: \"Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, " +
        "whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. " +
        "Report a punch list — done vs. missing. Under 200 words.\"\n" +
      "})\n" +
      "<commentary>\n" +
      "The prompt is self-contained: it states the goal, lists what to check, and caps the response length. " +
      "The agent's report comes back as the tool result; relay the findings to the user.\n" +
      "</commentary>\n" +
      "</example>\n\n" +

      "<example>\n" +
      "user: \"Is the pricing in our billing doc still current?\"\n" +
      "assistant: A cutoff-sensitive external fact, so launch a webresearcher for cited current evidence.\n" +
      "run_agent({\n" +
      "  type: \"webresearcher\",\n" +
      "  description: \"Verify vendor pricing is current\",\n" +
      "  prompt: \"Check whether the per-seat and usage prices for <vendor>'s Team plan are still what our billing doc claims: " +
        "$X per seat per month and $Y per 1M units. Context: the doc was written months ago and we are about to quote these " +
        "numbers to a customer, so a stale figure is expensive. Report the current published figures with source links and " +
        "effective dates, and say plainly whether each of our two numbers is still correct. Under 200 words.\",\n" +
      "  run_in_background: true\n" +
      "})\n" +
      "<commentary>\n" +
      "The agent starts with no context from this conversation, so the prompt briefs it: " +
      "what to verify, what to assess, the relevant background, and what form the answer should take. " +
      "It runs in the background because the conversation can continue without the answer.\n" +
      "</commentary>\n\n" +
      "</example>\n\n" +

      "When work relates to a GitHub issue, reference its number in `prompt` so the launched agent can fetch the issue itself.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: MCP_LAUNCHABLE_AGENT_TYPES,
          default: MCP_DEFAULT_AGENT_TYPE,
          description: `One of the agent roles above; defaults to \`${MCP_DEFAULT_AGENT_TYPE}\` when omitted.`,
        },
        prompt: {
          type: "string",
          minLength: 1,
          description: "The agent's opening message, as free text.",
        },
        description: {
          type: "string",
          minLength: 1,
          description: "A short (3-6 word) description of the task",
        },
        interactive: {
          type: "boolean",
          description: "Whether to hand the session to the user instead of running it automated. Explore and webresearcher reject true; brainstormer is always interactive.",
        },
        run_in_background: {
          type: "boolean",
          description: "Set to true to run this agent in the background (you will be notified when it completes), or false to wait and get the result immediately.",
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_create",
    description:
      "Add one or more high-level tasks to the project's durable roadmap as a system-managed GitHub issue. " +
      "Use this only to record newly identified project work or priorities; implementation details belong in the issue that carries the work. " +
      "The current roadmap is supplied in context, " +
      "so there is deliberately no roadmap read tool and no full-body replacement operation; " +
      "do not use `gh` to bypass this unless the user explicitly asks for it.\n\n" +

      "Send related subjects together in priority order. " +
      "Each subject must be a directional single line of at most 200 characters " +
      "with no leading list or heading markup.\n\n" +

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
          description: "New task subjects, in priority order. Single directional line, no leading list or heading markup.",
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
      "Use `deleted` only when the user explicitly asks for deletion. " +
      "There is no in-progress status; live work is already derived from issues, pull requests, agent sessions.\n\n" +

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
            "At least the first 40 characters of the task's current subject, copied exactly. " +
            "It confirms this position still holds the task you mean.",
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
      "Start the implementation of all eligible open issues labelled `[AI]-afk` or `[AI]-hitl`, with dependencies first, auto delegated to coding agents. " +
      "Use this only after the user has approved the work and the issues are ready to address. " +
      "Use `run_agent` only for fast or unplanned changes, not to bypass this issue workflow.\n\n" +

      "The call is non-blocking. On refusal, relay the returned reason, especially dirty paths; " +
      "do not alter unrelated work or guess how to resolve a failed precondition.\n\n" +

      "On success it returns the frozen issue order and any skipped issues with reasons. " +
      "Report that plan and continue the conversation; do not wait or poll. " +
      "Calling again while a run is active returns that run instead of starting another.\n\n" +

      "`[AI]-afk` issues may proceed without user review. " +
      "`[AI]-hitl` issues wait for user review and merge. " +
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
          description: "Pull-request number to target. Defaults to latest open pull request.",
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
    "Launch one visible, independent, fresh agent session. " +
    "Use this when a coherent unit of work should be delegated " +
    "and the user should be able to watch, interrupt, or take over.\n\n" +

    "## Choosing the agent type\n\n" +
    "`type` is required and must name one of the evidence-gathering roles below.\n" +
    "- `Explore`: Read-only search agent for code exploration. " +
      "Use it to get up-to-date codebase reports. " +
      "Do NOT use it for code review or design-doc auditing — it is not meant to make judgments; it is impartial and only surfaces facts. " +
      "When calling, specify search breadth: \"quick\" for a single targeted lookup, \"medium\" for moderate exploration, " +
      "or \"very thorough\" to search across multiple locations and naming conventions.\n" +
    "- `webresearcher`: automated, read-only research for cutoff-sensitive external facts. " +
      "Use for current documentation, versions, pricing, standards, advisories, " +
      "or vendor behavior that may have changed; it returns cited current evidence.\n" +
    "- `prototyper`: a throwaway experiment that produces evidence for the brainstorm in the project's own prototype location, asking the user where to write when the project defines none. " +
      "It can run independently or as a user-driven interactive session.\n\n" +

    "## When to use or not use\n\n" +
    "If the target is already known, use the direct tool: Read for a known path, " +
    "the Grep tool for a specific symbol or string. " +
    "Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.\n\n" +

    "## Usage\n\n" +
    "- Always include a short description summarizing what the agent will do.\n" +
    "- When you launch multiple agents for independent work, send them in a single message " +
      "with multiple tool uses so they run concurrently. " +
      "If the user asks for agents \"in parallel\", you MUST send one message with several `run_agent` calls in it.\n" +
    "- `interactive: true` hands a `prototyper` session to the user. Its report arrives after the user runs `/done`. " +
      "Use it when the experiment is one the user should direct. " +
      "`webresearcher` and `Explore` are non-interactive and reject `interactive: true`. " +
      "If an automated prototyper finds no project-defined location, it returns without writing so you can ask the user where the prototype should live.\n" +
    "- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — " +
      "e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel. " +
      "When an agent runs in the background, you will be automatically notified when it completes — " +
      "do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.\n" +
    "- Summarize an automated result for the user. Check the evidence before using it to settle the brainstorm.\n\n" +

    "## Writing the prompt\n\n" +
    "`prompt` is the agent's opening message. It is required for a non-interactive launch; " +
    "for an interactive one, omit it unless the user gave an explicit opening topic.\n\n" +
    "Brief the agent like a smart colleague who just walked into the room — " +
    "it has not seen this conversation, does not know what you have tried, does not understand why this task matters.\n" +
    "- Explain what you are trying to accomplish and why.\n" +
    "- Describe what you have already learned or ruled out, including rejected approaches.\n" +
    "- Give enough context about the surrounding problem that the agent can make judgment calls " +
      "rather than just following a narrow instruction.\n" +
    "- Name the exact question or bounded task, and what output or validation proves completion.\n" +
    "- If you need a short response, say so (\"report in under 200 words\").\n" +
    "- Lookups: hand over the exact command. Investigations: hand over the question — " +
      "prescribed steps become dead weight when the premise is wrong.\n\n" +
    "Terse command-style prompts produce shallow, generic work. " +
    "Never delegate understanding: do not write \"based on your findings, fix the bug\" " +
    "or \"based on the research, implement it.\" " +
    "Those phrases push synthesis onto the agent instead of doing it yourself. " +
    "Write prompts that prove you understood — what specifically to change.\n\n" +

    "<example>\n" +
    "user: \"Does this extension already have a boundary for persisting launch policy?\"\n" +
    "assistant: A repository question spanning domain state, persistence, and resume behavior. " +
      "Delegate it to Explore and ask for a short factual report so the raw search output stays out of the brainstormer's context.\n" +
    "run_agent({\n" +
    "  type: \"Explore\",\n" +
    "  description: \"Trace launch policy persistence\",\n" +
    "  prompt: \"Very thoroughly trace whether launch policy is persisted and restored for resumed sessions. " +
      "Context: we are deciding whether a proposed design needs a new persistence boundary. Identify the authoritative types, " +
      "writers, readers, and focused tests. Report facts with file paths and flag any policy fields that are recomputed instead. Under 200 words.\"\n" +
    "})\n" +
    "<commentary>\n" +
    "The prompt is self-contained: it states the design question, names the evidence to find, and caps the response length. " +
    "The agent's report comes back as the tool result; use the findings to continue the brainstorm.\n" +
    "</commentary>\n" +
    "</example>\n\n" +

    "<example>\n" +
    "user: \"I'd like to see whether a three-column agent card is actually readable before we commit to it.\"\n" +
    "assistant: A user-directed scratch experiment, so launch a prototyper with the design context and a concrete validation target.\n" +
    "run_agent({\n" +
    "  type: \"prototyper\",\n" +
    "  description: \"Prototype three-column agent card\",\n" +
    "  interactive: true,\n" +
    "  prompt: \"Prototype a three-column agent card using the project's established prototype location. " +
      "Context: the card must keep session identity, live status, and primary actions visible at narrow panel widths without hiding work. " +
      "Create only enough UI to compare the layout at 300 px and 500 px, then show the user the result and record the tradeoffs they observe.\"\n" +
    "})\n" +
    "<commentary>\n" +
    "The prototyper opens in an interactive terminal because the user needs to inspect and direct the experiment. " +
    "Its report arrives after the user runs `/done`.\n" +
    "</commentary>\n" +
    "</example>",
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
        description: "The agent's opening message, as free text.",
      },
      description: {
        type: "string",
        minLength: 1,
        description: "A distinct 3-6 word label for the visible terminal.",
      },
      interactive: {
        type: "boolean",
        description: "Whether to hand a prototyper session to the user instead of running it automated. Explore and webresearcher reject true.",
      },
      run_in_background: {
        type: "boolean",
        description: "Set to true to run this agent in the background (you will be notified when it completes), or false to wait and get the result immediately.",
      },
    },
    required: ["type", "description"],
    additionalProperties: false,
  },
};

const CONTINUE_AGENT: McpTool = {
  name: "continue_agent",
  description:
    "Resume an agent session and provide one follow-up message, appended to its current transcript. " +
    "Your plain text output is NOT visible to other agents — " +
    "to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox. " +
    "Refer to agents by the agent_id returned by `run_agent` or by a manual run notification.\n" +
    "The tool call may fail if it is used at an inappropriate time; for example, if the agent is still running and has not delivered a report.",
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
