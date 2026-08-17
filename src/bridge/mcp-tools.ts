import { MCP_LAUNCHABLE_AGENT_TYPES } from "../domain/contracts.js";
import { ROADMAP_TASK_STATUSES } from "../domain/roadmap.js";


export interface McpTool {
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
      "Use `general-purpose` for direct full-tool work, `Explore` for read-only repository search, " +
      "`brainstormer` for a user-driven product or architecture conversation, " +
      "and `webresearcher` for up to date facts and documentation. " +
      "Implementation roles are intentionally unavailable here; use `start_auto_run` for issue implementation.",
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
      "rather than a generic label such as 'Investigate code'. " +
      "Length is best-effort, never a failure: a label outside 3-6 words is normalized " +
      "to fit (truncated or extended from the prompt) and applied with a notice.",
  },
  issue: {
    type: "integer",
    minimum: 1,
    description:
      "Optional positive GitHub issue number. " +
      "When present, Aboard resolves the issue and parent specification " +
      "and merges that contract into the opening prompt; " +
      "do not spend an agent turn fetching launch-contract material again. " +
      "Examples: automated exploration against an issue, " +
      "`{ type: 'Explore', prompt: 'Investigate how the retry backlog in #52 is handled today and report where it lives', issue: 52 }`; " +
      "or a fast change the user will drive, " +
      "`{ type: 'general-purpose', interactive: true, prompt: 'Work with me on the session loss reported in #47', issue: 47 }`. " +
      "Always pair it with `prompt` naming what the agent does with the issue; " +
      "an interactive launch without `prompt` opens with no first message and the issue goes unused, with a notice.",
  },
  interactive: {
    type: "boolean",
    description:
      "Defaults to false. " +
      "Set true only when the user should drive the terminal directly. " +
      "The terminal is focused and no result is delivered back to you, " +
      "and never wait, poll, or promise a later summary. " +
      "It becomes the user's responsibility. " +
      "Key constraints: `brainstormer` is always interactive, `webresearcher` and `Explore` cannot be interactive." +
      "Other agents can be interactive or not. Not respecting this will immedialty fail.",
  },
  run_in_background: {
    type: "boolean",
    description:
      "Applies only to automated launches. " +
      "Defaults to false, which blocks until the final result is needed for the current decision. " +
      "Set true only for independent work that may finish later; " +
      "the call returns immediately and completion is delivered as a later notification. " +
      "Ignored with a notice when `interactive` is true.",
  },
} as const;

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
      "Launch one visible, independent Claude Code session in a real terminal created by Aboard. " +
      "Use this when a coherent unit of work should be delegated " +
      "and the user should be able to watch, interrupt, or take over. " +
      "Do not use it for one known-file read, one targeted symbol lookup, " +
      "or to fetch roadmap, fleet, issue, pull-request, or git state already supplied in context.\n\n" +

      "Choose the role deliberately:\n" +
      "- `general-purpose`: Claude Code's unmodified default full-tool session, " +
      "for direct coding that may mix investigation and editing. " +
      "This is the path for a fast change or a critical fix too small to deserve a spec; " +
      "complex or planned implementation goes through `start_auto_run` instead, " +
      "which owns branches, commits, and pull requests. " +
      "It can be automated or handed to the user.\n" +
      "- `Explore`: Claude Code's built-in read-only repository search role. " +
      "Use for locating files, references, patterns, or answering where code lives. " +
      "State quick, medium, or very thorough breadth in the prompt. " +
      "It is automated only.\n" +
      "- `brainstormer`: a user-driven conversation that resolves a vague product or architecture idea " +
      "into an implementation-ready durable specification. " +
      "It is interactive only.\n" +
      "- `webresearcher`: automated, read-only research for cutoff-sensitive external facts. " +
      "Use for current documentation, versions, pricing, standards, advisories, " +
      "or vendor behavior that may have changed; it returns cited current evidence.\n" +
      "Implementation agents and pull-request doctors are not available through this tool. " +
      "Use `start_auto_run` for approved issue implementation " +
      "and `review_pr` to hand an existing pull-request session back to the user.\n\n" +

      "Mode and delivery are separate decisions. " +
      "An interactive launch focuses the terminal for the user and never returns an agent result. " +
      "An automated foreground launch waits for the final result " +
      "when that answer is required before making the next recommendation. " +
      "`run_in_background` returns immediately and should be used only when the work is independent; " +
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
      "because interactive overlap is the user's decision.",
    inputSchema: {
      type: "object",
      properties: LAUNCH_PROPERTIES,
      required: ["type", "description"],
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
          enum: [...ROADMAP_TASK_STATUSES],
          description:
            "Optional status. " +
            "pending reopens remaining work; completed checks the task in place permanently; " +
            "deleted removes it and is allowed only on the user's explicit request. " +
            "There is no in-progress status; live state is derived elsewhere.",
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
    description:
      "Start Aboard's automatic implementation workflow for the oldest open ai:spec issue. " +
      "Use this only after the user has approved implementation " +
      "and the specification and child issues are ready. " +
      "Do not use `run_agent` to bypass this workflow: " +
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
      "leaving visible work in place for inspection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
          description:
            "Optional positive pull-request number. " +
            "Omit to use the latest open pull request.",
        },
        focus: {
          type: "string",
          minLength: 1,
          description:
            "Optional concise topic naming what the user wants to inspect or discuss. " +
            "Used as the opening handoff context when Aboard must create a fallback interactive session; " +
            "otherwise it is returned as unusedFocus and the user retypes it in the terminal.",
        },
      },
      additionalProperties: false,
    },
  },
];
