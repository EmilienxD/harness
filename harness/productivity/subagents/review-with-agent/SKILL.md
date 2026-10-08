---
name: review-with-agent
description: Launch an agent to review a pinned change. Use when the user wants a separate agent to inspect and validate a target.
argument-hint: "[review target or expectations]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run a subagent with the `review` task.

Invoke the `subagents-toolkit` skill if you don't already have its instructions in your context, then follow its workflow using the conversation inbox supplied by the hook.

Request parameters:
- task: review
- mode: interactive or auto (default auto)
- provider (Optional): claude, chatgpt, or codex (alias of chatgpt)

State the review scope, relevant changes, and validation expectations. The task param already tells the agent how to review, not what to review.
