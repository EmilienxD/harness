---
name: work-with-agent
description: User-invoked only. Agents must not invoke this skill on their own. Launch a general-purpose agent for a delegated task. Use when the user wants a separate agent to handle work that does not fit a more specific delegation skill.
argument-hint: "[task and mode/provider/model preferences]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run an agent with the `general` task.

Invoke the `subagents-toolkit` skill if its instructions are not already in the current context, then follow its workflow using the conversation inbox supplied by the runtime.

Request parameters:
- task: general
- mode: interactive or auto (default interactive)
- provider (Optional): claude, chatgpt, codex (alias of chatgpt), or pi
- model (Optional): model ID
- root (Optional): existing directory or worktree path, only when the user explicitly requests another root

Give the child a bounded task and the relevant project context.
