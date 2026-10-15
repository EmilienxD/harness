---
name: subagents-toolkit
description: Manage subagents when the user explicitly requests delegation. Use when the user asks to invoke, run, launch, delegate to Codex/ChatGPT/Claude agents/subagents.
license: MIT
metadata:
  author: EMB
---

# Subagents toolkit

A subagent is an agent whose parent is you.

Use the assigned inbox supplied by the session-start hook for every subagent launch and continuation, including after this conversation is resumed. If the hook has not supplied an inbox, stop and notify the user. Launch subagents only when the user explicitly requests it. This method is now the default method for running subagents; always use it when the user wants to "run subagents", "delegate the work to", or "resume subagents".

Write one Markdown file directly in the supplied inbox for each subagent. When the user requests multiple subagents, write their separate request files in parallel; each file launches independently, so never combine multiple subagents in one file. Writing to this inbox will automatically launch the subagent. You will be notified when it completes — do not poll; never sleep, poll, proactively check progress, or run a command to do so. Do other work that doesn't depend on the subagent's result. End your turn to wait for the result of whichever subagent finishes first.

Launch frontmatter schema (`|` separates enum values):

```markdown
---
task: <registered task>    # Required. Selects a built-in or custom task (see below).
mode: auto|interactive    # Required. Spawn the subagent in a headless or visible terminal.
provider: claude|chatgpt|codex    # Optional. Defaults to this conversation's provider. `codex` is an alias of chatgpt.
model: <model id>         # Optional. Include only when the user explicitly requests a particular model.
root: <directory path>    # Optional. Include only when the user explicitly requests another root.
---

<prompt for the new subagent>
```

## Model selection

Include `model` only when the user explicitly requests a particular model for the subagent. Otherwise omit the field and let the runtime apply its existing task profile and native provider defaults.

Use the requested model's exact ID for the selected provider from this list:
- ChatGPT/Codex: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
- Claude`claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`

If the requested model is absent, tell the user the list needs updating before launching with that model. An explicit model overrides the task default.

## Root selection

Omit `root` to start the child in this conversation's working directory. When the user explicitly asks the child to work in another directory or worktree, set `root` to that directory's path. Use an existing directory; relative paths resolve from this conversation's working directory. A resumed child keeps its original root, so resume requests contain only `resume`.

## Task selection

Below is the built-in list of tasks, allowed modes, and default mode:

```yaml
general:
  launcher: work-with-agent
  modes: [auto, interactive]
  default-mode: interactive
explore:
  launcher: explore-with-agent
  modes: [auto]
  default-mode: auto
prototype:
  launcher: prototype-with-agent
  modes: [interactive]
  default-mode: interactive
websearch:
  launcher: websearch-with-agent
  modes: [auto, interactive]
  default-mode: auto
brainstorm:
  launcher: brainstorm-with-agent
  modes: [interactive]
  default-mode: interactive
address:
  launcher: address-with-agent
  modes: [auto, interactive]
  default-mode: auto
review:
  launcher: review-with-agent
  modes: [auto, interactive]
  default-mode: auto
```

Use `auto` when the subagent should work independently and report back. Use `interactive` when the user wants to work with the subagent directly in its visible session. Choose a mode allowed by the registered task, using its default when the user has not selected a mode.

Determine the task from the user's request and the preceding conversation. When the invocation supplies no new task, use the subject already under discussion and any description supplied as an argument. If no built-in task is suitable, read `.harness/subagent-tasks.yaml` and `~/.harness/subagent-tasks.yaml` to discover the user's custom tasks. Disregard the `skill` entry; it doesn't affect the inbox system. If these registries are empty or if nothing still fits the task, fall back to the `general` task. The general task should be used only as a fallback or if the user explicitly asks for it.

Each new subagent starts with a fresh conversation and knows only the project and user memory files such as `AGENTS.md`/`CLAUDE.md`. Give it a self-contained prompt that explains why, what, where, and how, including constraints and completion criteria, without repeating general project information it can read there.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the subagent's context, saving tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45). Do not append them to the file path (e.g., @src/core.py:25); that format is not supported. If relevant code is not saved in the project, include the necessary parts as small snippets.

Perspective change:
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

Agents have stable identifiers (e.g. `agent-1`, `agent-2`). Continue any subagent at any time with exclusive resume frontmatter and a nonempty next message; it keeps its task, provider, model, mode, directory, and id:

```markdown
---
resume: agent-3
---
Continue with this next task.
```

Any new request needs a fresh filename; do not waste time listing existing files; you are the only writer of this inbox, so you already know which filename is already taken (you created them earlier). The filename has no impact.
