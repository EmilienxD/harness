---
name: subagents-toolkit
description: Manage persistent subagents when the user explicitly requests launching, delegating to, continuing, or resuming Claude Code, ChatGPT/Codex, or Pi agents.
license: MIT
metadata:
  author: EMB
---

# Subagents toolkit

Launch or continue subagents only when the user explicitly requests delegation. Use the assigned conversation inbox supplied by the runtime, including after resume. If no inbox was supplied, stop and report the missing runtime context.

Publish one complete `.md` request directly in that inbox per child launch or continuation. For multi-step writes, use a temporary file with another extension and rename it to `.md` when complete. Confirm the runtime's launch acknowledgement before reporting a child as started. If launch or continuation fails, report the available error details and stop without retrying or substituting another workflow.

Results arrive automatically. Do independent work while children run; when nothing remains independent of their results, end your turn to wait. Never poll, sleep, or run progress-checking commands.

Launch frontmatter schema (`|` separates enum values):

```markdown
---
skill: <skill name>       # Optional. Include only the skill explicitly named by the user.
mode: auto|interactive    # Required. Spawn the subagent in a headless or visible terminal.
provider: claude|chatgpt|codex|pi    # Optional. Defaults to this conversation's provider. `codex` is an alias of chatgpt.
model: <model id>         # Optional. Include only when the user explicitly requests a particular model.
effort: none|minimal|low|medium|high|xhigh|max|ultra    # Optional. Include only when the user requests an effort level.
root: <directory path>    # Optional. Include only when the user explicitly requests another root.
---

<prompt for the new subagent>
```

## Model selection

Include `model` only when the user explicitly requests a particular model for the subagent. Otherwise omit the field and let the runtime apply its general delegation profile and native provider defaults.

Use the requested model's exact ID for the selected provider from this list:
- ChatGPT/Codex: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
- Claude: `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`
- Pi: Any model id from ChatGPT or Claude above, with the prefix `openai/` or `anthropic/` respectively (e.g. `anthropic/claude-opus-5-5`). Use when the user mention Pi.

If the requested model is absent, tell the user the list needs updating before launching with that model. An explicit model overrides the delegation default.

## Effort selection

Include `effort` when the user requests an effort level for the subagent; otherwise omit it to retain the general delegation profile and provider defaults. Use the requested level from the launch schema independently of `model`.

## Root selection

Omit `root` to start the subagent in this conversation's working directory. When the user explicitly asks the subagent to work in another directory or worktree, set `root` to that directory's path. Use an existing directory; relative paths resolve from this conversation's working directory. A resumed subagent keeps its original root, so resume requests contain only `resume`.

## Skill and mode selection

Set `skill` only when the user explicitly asks the subagent to use a skill by name. Use the exact skill name provided, without a prefix such as `/`, `$`, `/skill:`. The system checks availability and adds the native invocation to its prompt. An unavailable skill fails the launch; report the error to the user and stop.

Use `auto` when the subagent should work independently and report back. Use `interactive` when the user wants to work directly in its visible session; default to interactive when unspecified. Both modes accept skills.

Give the subagent only the requested skill selection. Instruct it to use skills only when explicitly requested by the user, subject to its project and provider instructions.

Each new subagent starts with a fresh conversation and knows only the project and user memory files such as `AGENTS.md`/`CLAUDE.md`. Give it a self-contained prompt that explains why, what, where, and how, including constraints and completion criteria, without repeating general project information it can read there.

Reference files as `@absolute/or/relative/to/the/project/root/path`. On Pi, automatic loading requires the file-mentions extension to be installed and active in the child session. Without it, keep the reference and ask the child to read the file explicitly. Refer to line numbers in plain text (e.g., lines 14-45). Do not append them to the file path (e.g., @src/core.py:25); that format is not supported. If relevant code is not saved in the project, include the necessary parts as small snippets.

Perspective change:
- For interactive agents: "I" is the user, not you; never write "The user wants to ...".
- For auto agent:, "I" is you; the parent agent.

Interactive example:

```markdown
---
mode: interactive
---

It has been decided to simplify the configuration API in @src/config. Help me evaluate the current design and decide which compatibility constraints the new API should preserve.
```

Auto example:

```markdown
---
mode: auto
---

The user wants to understand why configuration precedence differs between the two adapters. Inspect @src/config and report the cause, the affected paths, and the safest correction. Do not make changes.
```

In real requests, include all details the subagent needs to act.

Agents have stable identifiers (e.g. `agent-1`, `agent-2`). Continue any subagent at any time with exclusive resume frontmatter and a nonempty next message; it keeps its conversation, provider, model, effort, mode, directory, and id:

```markdown
---
resume: agent-3
---
Continue with this next task.
```

Any new request needs a fresh filename; do not waste time listing existing files; you are the only writer of this inbox, so you already know which filename is already taken (you created them earlier). The filename has no impact. The system deletes each inbox `.md` file as soon as it processes the request no matter the outcome (success/fail). Every launch, continuation, or user-requested retry requires a new complete file with a fresh filename. 
