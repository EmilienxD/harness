---
name: brainstorm-with-agent
description: Launch a interactive agent to brainstorm a plan or design with the user. Use when the user wants a separate agent to question, clarify, or stress-test their thinking.
argument-hint: "[topic]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Brainstorm with an Agent

Follow the delegation workflow injected by the hook, using the persistent conversation inbox. Launch only after the user explicitly requests delegation.

Request parameters: `task: brainstorm`; mode: interactive; optional provider: `claude` or `chatgpt`.

State the design question and constraints for the user to explore interactively. The runtime selects the grill-me workflow.
