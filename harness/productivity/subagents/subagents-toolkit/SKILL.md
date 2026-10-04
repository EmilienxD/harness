---
name: subagents-toolkit
description: Manage subagents when the user explicitly requests delegation. Use when the user asks to invoke, run, launch, delegate to Codex/Chatgpt/Claude agents/subagents.
license: MIT
metadata:
  author: EMB
---

# Subagents toolkit

A subagent is an agent whose parent is you.

Use the conversation inbox supplied by the runtime hook for every subagent launch and continuation, including after this conversation is resumed. If the hook has not supplied an inbox, stop and notify the user. Launch subagents only when the user explicitly requests it. Use this workflow when the user wants to run subagents, delegate work, or resume subagents.

Write one Markdown file directly in the supplied inbox for each subagent using a structured file-writing tool such as Write or apply_patch. When the user requests multiple subagents, write their separate request files in parallel; each file launches independently, so never combine multiple subagents in one file. The runtime launches each subagent after the file write. You will be notified when it completes. Do other work that does not depend on its result, then end your turn to wait for the next completion. Do not poll or sleep to check progress.

Launch frontmatter schema (`|` separates enum values):

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

Each new subagent starts with a fresh conversation and knows only project memory files such as `AGENTS.md` and `CLAUDE.md`. Give it a self-contained prompt that explains why, what, where, and how, including constraints and completion criteria, without repeating general project information it can read there.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the subagent's context, saving tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45). Do not append them to the file path (e.g., @src/core.py:25); that format is not supported. If relevant code is not saved in the project, include the necessary parts as small snippets.

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

In real requests, include all details the subagent needs to act.

Agents have stable identifiers (e.g. `agent-1`, `agent-2`). Continue any subagent at any time with exclusive resume frontmatter and a nonempty next message; it keeps its task, provider, mode, directory, and id:

```markdown
---
resume: agent-3
---
Continue with this next task.
```

Give each new request a fresh filename, tracking the names you have already used in this inbox. The filename does not select the task, mode, or provider.
