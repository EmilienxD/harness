---
name: work-with-agent
description: Launch a general-purpose agent for a delegated task. Use when the user wants a separate agent to handle work that does not fit a more specific delegation skill.
argument-hint: "[task and mode/provider preferences]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Work with an Agent

Follow the shared delegation workflow and inbox supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Request parameters:
- task: general
- mode: interactive or auto (default auto)
- provider (Optional): `claude` or `chatgpt`

Give the child a bounded task and the relevant project context.
