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

Follow the delegation workflow injected by the hook, using the persistent conversation inbox. Launch only after the user explicitly requests delegation.

Request parameters: `task: general`; mode: interactive or auto (default auto); optional provider: `claude` or `chatgpt`.

Give the child a bounded task and the relevant project context.
