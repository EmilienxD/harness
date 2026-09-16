---
name: review-with-agent
description: Launch a agent to review a pinned change. Use when the user wants a separate agent to inspect and validate a target.
argument-hint: "[review target or expectations]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Review with an Agent

Follow the delegation workflow injected by the hook, using the persistent conversation inbox. Launch only after the user explicitly requests delegation.

Request parameters: `task: review`; mode: interactive or auto (default auto); optional provider: `claude` or `chatgpt`.

State the review scope, relevant changes, and validation expectations. The runtime selects the review-this workflow.
