---
name: prototype-with-agent
description: Launch a agent to build a focused prototype. Use when the user wants a separate agent to test an idea through a disposable implementation.
argument-hint: "[prototype task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Prototype with an Agent

Follow the delegation workflow injected by the hook, using the persistent conversation inbox. Launch only after the user explicitly requests delegation.

Request parameters: `task: prototype`; mode: interactive or auto (default auto); optional provider: `claude` or `chatgpt`.

Describe the disposable experiment and its success criteria. The runtime selects the prototype workflow.
