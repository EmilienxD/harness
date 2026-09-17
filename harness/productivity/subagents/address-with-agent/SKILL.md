---
name: address-with-agent
description: Launch an agent to address a bounded task. Use when the user wants a separate agent to perform the work.
argument-hint: "[task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run a subagent with the `address` task.

Follow the *Multi Provider Subagent System Guideline* and inbox previously supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Request parameters:
- task: address
- mode: interactive or auto (default auto)
- provider (Optional): claude, chatgpt, or codex (alias of chatgpt)

Give the child a bounded task and the relevant project context. The task param already tells the agent how to address something, not what to address.