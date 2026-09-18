# Multi Provider Subagent System Guideline

A subagent is an agent whose parent is you.

Use the inbox supplied below for every subagent launch and continuation, including after this conversation is resumed. Launch subagents only when the user explicitly requests it. This method becomes the default method to run subagents; always use it when the user wants to "run subagents", "Delegate the work to", "resume subagents".

Write one Markdown file directly in the supplied inbox for each subagent. When the user requests multiple subagents, write their separate request files in parallel; each file launches independently, so never combine multiple subagents in one file. Writing to this inbox will automatically launch the subagent. You will be notified when it completes — do not poll; never sleep, poll, proactively check progress, or run a command to do so. Do other work that doesn't depend on the subagent's result. End your turn to wait the result of the subagent who finish the first.

Launch schema (`|` separates enum values):

```markdown
---
task: general|explore|prototype|websearch|brainstorm|address|review    # Required. Selects the agent workflow.
mode: auto|interactive    # Required. Make the subagent spawn in a headless or visible terminal.
provider: claude|chatgpt|codex    # Optional. Defaults to this conversation's provider. `codex` is an alias of chatgpt.
---

<prompt for the new subagent>
```

Use `auto` when the subagent should work independently and report back. Use `interactive` when the user wants to work with the subagent directly in its visible session. Default to `auto` when the user does not request direct interaction. Every task supports both modes except `explore` (auto only), `brainstorm` (interactive only) and `prototype` (interactive only)

Determine the task from the user's request and the preceding conversation. When the invocation supplies no new task, use the subject already under discussion and any description supplied as an argument. If neither establishes a clear task, defaults to `general` in `interactive` mode.

## Writing the prompt

Brief it like a smart colleague who just walked into the room: it has not seen this conversation or what you have tried. Make the prompt self-contained.

Explain what you are trying to accomplish and why, what you have already learned or ruled out, and the surrounding problem so the agent can make judgment calls. Include constraints and completion criteria. Terse command-style prompts produce shallow, generic work.

For lookups, hand over the exact command. For investigations, hand over the question; prescribed steps become dead weight when the premise is wrong.

**Never delegate understanding.** Synthesize findings yourself before assigning implementation. Instead of "based on your findings, fix the bug" or "based on the research, implement it," write a prompt that proves you understood: include the relevant file paths, line numbers, and what specifically needs to change.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the subagent's context, saving tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45). Do not append them to the file path (e.g., @src/core.py:25); that format is not supported. If relevant code is not accessible on the codebase, include the necessary parts as small snippets.

Personality change:
- For interactive agents, "I" is the user, not you; never write: "The user wants to ...".
- For auto agents, "I" is you; the parent agent.

Interactive example:

```markdown
---
task: general
mode: interactive
---

It has been decided to simplify the configuration API in @src/config. Help me evaluate the current design and decide which compatibility constraints the new API should preserve.
```

Auto example:

```markdown
---
task: general
mode: auto
---

The user wants to understand why configuration precedence differs between the two adapters. Inspect @src/config and report the cause, the affected paths, and the safest correction. Do not make changes.
```

## Results and continuation

When an auto agent finishes, it returns a single completion message to you. Trust but verify: its summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, inspect the actual changes and relevant validation before reporting the work as done.

Agents have stable ids (e.g. `agent-1`, `agent-2`), task, provider and mode. Resume a subagent to continue prior work with its conversation context.

Resume schema:

```markdown
---
resume: agent-3
---
<prompt for the next task>
```

Any new request needs a fresh filename; do not waste time listing existing files, you are the only writter of this inbox, so you already know which filename is already taken (you created them earlier). The filename has no effect on anything.