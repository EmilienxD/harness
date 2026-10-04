---
name: work-with-agent
description: Launch a general-purpose agent for a delegated task. Use when the user wants a separate agent to handle work that does not fit a more specific delegation skill.
argument-hint: "[task and mode/provider preferences]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run an agent with the `general` task.

Invoke the `subagents-toolkit` skill if its instructions are not already in the current context, then follow its workflow using the conversation inbox supplied by the hook.

Request parameters:
- task: general
- mode: interactive or auto (default auto)
- provider (Optional): claude, chatgpt, or codex (alias of chatgpt)

Give the child a bounded task and the relevant project context.
