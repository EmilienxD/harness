---
name: prototype-with-agent
description: Launch an agent to build a focused prototype. Use when the user wants a separate agent to test an idea through a disposable implementation.
argument-hint: "[prototype task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Prototype with an Agent

Follow the shared delegation workflow and inbox supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Request parameters:
- task: prototype
- mode: interactive
- provider (Optional): `claude`, `chatgpt`, or `codex` (alias of `chatgpt`)

Describe the disposable experiment and its success criteria. The task param already tells the agent how to prototype, not what to prototype.
