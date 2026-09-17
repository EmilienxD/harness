---
name: address-with-agent
description: Launch an agent to implement and validate a bounded change. Use when the user wants a separate agent to perform the work.
argument-hint: "[implementation task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Address with an Agent

Follow the shared delegation workflow and inbox supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Request parameters:
- task: address
- mode: interactive or auto (default auto)
- provider (Optional): `claude` or `chatgpt`

Give the child a bounded task and the relevant project context. The task param already tells the agent how to address something, not what to address.