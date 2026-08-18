import { MCP_DEFAULT_AGENT_TYPE, MCP_LAUNCHABLE_AGENT_TYPES } from "../domain/contracts.js";
import { ROADMAP_TASK_STATUSES } from "../domain/roadmap.js";


export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

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
    description:
      "Launch one visible, independent, single-use agent session in a real terminal created by Aboard. " +
      "Use this when a coherent unit of work should be delegated " +
      "and the user should be able to watch, interrupt, or take over.\n\n" +

      "## When not to use\n\n" +
      "If the target is already known, use the direct tool: Read for a known path, " +
      "Grep for a specific symbol or string. " +
      "Reserve this tool for open-ended questions that span the codebase, " +
      "or tasks that match an available agent type. " +
      "Do not use it to fetch roadmap, fleet, issue, pull-request, or git state already supplied in context.\n" +
      "Everything else belongs here. Direct tools are for orientation only, a few targeted queries at a time; " +
      "as soon as a question needs several of them, or needs whole files read, it is a launch instead — " +
      "including when you believe you could answer it from what you already know, " +
      "which is what a half-remembered codebase feels like from the inside. " +
      "Answering it yourself spends the one context in the system that has to survive the whole project.\n\n" +

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
      "Implementation agents and pull-request doctors are not available through this tool.\n\n" +

      "## Usage notes\n\n" +
      "- `chrome: true` explicitly enables Claude in Chrome for a `general-purpose` session. " +
        "Set it only when the user has chosen browser access for this launch; do not infer consent from a UI-related task. " +
        "It is rejected for narrower roles and defaults to false.\n" +
      "- `interactive: true` opens the session as a real terminal handed to the user to drive, " +
        "and it returns no result at all — nothing comes back to you, ever. " +
        "Use it when the work is a conversation the user should be having, not a task you need an answer from, " +
        "and then continue with the user instead of waiting. " +
        "`prompt` there is only the opening topic and may be omitted. " +
        "`brainstormer` is interactive only; `webresearcher` and `Explore` are automated only and reject `interactive`.\n" +
      "- Mode and delivery are separate decisions: `interactive` decides whether a result exists at all, " +
        "`run_in_background` only decides when an automated result arrives.\n" +
      "- Foreground (the default) blocks until the agent's final result lands. " +
        "Use it when you need that answer before you can proceed — " +
        "research whose findings inform your next recommendation. " +
        "`run_in_background: true` returns immediately and is for genuinely independent work; " +
        "you are notified automatically when the agent completes, so do NOT sleep, poll, " +
        "or proactively check on its progress. Continue with other work or respond to the user instead.\n" +
      "- Always include a short `description` summarizing what the agent will do: " +
        "3-6 words, specific enough to tell two launches apart in the fleet tree — " +
        "\"Audit retry logic centralization\", not \"Investigate code\". " +
        "An out-of-range label is normalized to fit rather than rejected.\n" +
      "- When you launch multiple agents for independent work, send them in a single message " +
        "with multiple tool uses so they run concurrently. " +
        "If the user asks for agents \"in parallel\", you MUST send one message with several `run_agent` calls in it.\n" +
      "- An automated agent returns a single message back to you when it is done. " +
        "That result is not visible to the user, so send a text message summarizing it concisely.\n" +
      "- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. " +
        "When an agent writes or edits code, check the actual changes before reporting the work as done.\n" +
      "- Every launch starts a fresh conversation with no knowledge of the Manager's conversation.\n\n" +

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

      "## Attaching issues\n\n" +
      "`issues` names GitHub issues whose contract the agent needs. " +
      "Aboard merges each one and its parent spec into the opening prompt, " +
      "so do not spend a turn re-fetching that material. " +
      "Pass every issue the agent needs and no more: each arrives in full, " +
      "so a batch larger than one agent can hold and finish spends its context before it starts — " +
      "split unrelated or heavy issues into separate launches. " +
      "Always pair `issues` with `prompt`, or they go unused.\n\n" +

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
      "The prompt is self-contained: it states the goal, lists what to check, and caps the response length. " +
      "`type` is omitted, so this runs as `general-purpose`. " +
      "The agent's report comes back as the tool result; relay the findings to the user.\n" +
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
      "The agent starts with no context from this conversation, so the prompt briefs it: " +
      "what to verify, why it matters, and what form the answer should take. " +
      "It runs in the background because the conversation can continue without the answer; " +
      "the result arrives as a notification.\n" +
      "</example>\n\n" +

      "## Lease\n\n" +
      "Automated write-capable launches participate in the single-writer lease. " +
      "If another writer holds it, the call fails immediately with holder details; " +
      "surface that conflict instead of retrying or queueing. " +
      "Read-only and interactive sessions may run concurrently " +
      "because interactive overlap is the user's decision.",
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
          description: "A 3-6 word label for the fleet tree, e.g. 'Audit retry logic centralization'.",
        },
        issues: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "integer", minimum: 1 },
          description: "Optional GitHub issue numbers for the opening prompt if provided.",
        },
        interactive: {
          type: "boolean",
          description: "Whether to hand the session to the user instead of running it automated; false by default.",
        },
        run_in_background: {
          type: "boolean",
          description: "Whether an automated launch returns immediately instead of waiting for the result; false by default.",
        },
        chrome: {
          type: "boolean",
          description: "Explicitly enable Claude in Chrome for this general-purpose session; false by default.",
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_create",
    description:
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
      "Multiple roadmap carriers are reported but never modified or consolidated automatically.\n\n" +

      "Never issue this call alongside another roadmap write in the same message. " +
      "Every roadmap write rewrites the same issue body, so two in flight together lose one of the two edits, " +
      "and a call that renumbers invalidates the positions its neighbour was addressed against. " +
      "Batch within the call instead: one call takes many subjects.",
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
      "There is no in-progress status: live work is already derived from issues, pull requests, " +
      "and auto-run state, and any value outside the status enum is rejected.\n\n" +

      "Reprioritize with after='top' or after=<current position>; " +
      "moving is part of this update, not a separate operation. " +
      "after takes no confirmation of its own: a wrong anchor only misplaces the task in the order, " +
      "which the next roadmap block shows plainly. " +
      "A move or a deletion renumbers other tasks, so the result then carries tasks, " +
      "the pending list as it now stands; use it and discard the positions you were holding. " +
      "A status or subject change in place renumbers nothing and omits that list.\n\n" +

      "A replacement subject follows the same single-line, 200-character, no-leading-markup rules as creation. " +
      "Retitling does not change the task's position. " +
      "Non-checkbox roadmap text and all unrelated tasks remain untouched.\n\n" +

      "Never issue this call alongside another roadmap write in the same message. " +
      "Every roadmap write rewrites the same issue body, so two in flight together lose one of the two edits, " +
      "and a call that renumbers invalidates the positions its neighbour was addressed against. " +
      "Send them one at a time, each addressed against the result of the last.",
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
          description:
            "New status. deleted is allowed only on the user's explicit request. " +
            "There is no in-progress status; live state is derived elsewhere.",
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
      "Start Aboard's automatic implementation workflow for the oldest open ai:spec issue. " +
      "Use this only after the user has approved implementation " +
      "and the specification and child issues are ready. " +
      "Do not use `run_agent` to bypass this workflow: " +
      "the extension, not an agent, owns branch creation, commits, pushes, " +
      "pull requests, optional review launches, merges, and cleanup.\n\n" +

      "The call is non-blocking. Its optional `chrome` boolean applies one explicit user choice " +
      "to every implementer in this run and defaults to false. Do not infer consent from issue content. " +
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
      "leaving visible work in place for inspection.",
    inputSchema: {
      type: "object",
      properties: {
        chrome: {
          type: "boolean",
          description: "Enable Claude in Chrome for every implementer in this auto-run; false by default.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "review_pr",
    description:
      "Hand an existing open pull request's owning Aboard session back to the user " +
      "for interactive inspection or follow-up. " +
      "Use this when the user asks to review, inspect, discuss, or continue work on a pull request. " +
      "This does not perform a review, launch an automated reviewer, post comments, " +
      "approve, merge, or return a later agent result.\n\n" +

      "Omit pr to select the latest open pull request, " +
      "or provide a positive pull-request number to target one explicitly. " +
      "The optional focus text names what the user wants to inspect. " +
      "It steers the first pass only when Aboard must create a fallback session; " +
      "an existing session is already loaded and cannot be steered, " +
      "so the focus is returned as unusedFocus instead of being applied. " +
      "If the owning implementer or pull-request doctor is live, its terminal is focused; " +
      "if its recorded session is closed, it is resumed with its original restrictions. " +
      "If ownership is unavailable after a restart, " +
      "Aboard opens a fresh interactive pull-request doctor and reports that fallback. " +
      "If no matching open pull request exists, nothing is launched.",
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
          description:
            "Topic to focus the review on. Applied only when Aboard must launch a fallback session; " +
            "otherwise returned as unusedFocus.",
        },
      },
      additionalProperties: false,
    },
  },
];
