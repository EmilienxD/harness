---
name: brainstorm-with-agent
description: Launch an interactive agent to brainstorm a plan or design with the user. Use when the user wants a separate agent to question, clarify, or stress-test their thinking.
argument-hint: "[topic]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Brainstorm with an Agent

Follow the shared delegation workflow and inbox supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Request parameters:
- task: brainstorm
- mode: interactive
- provider (Optional): `claude` or `chatgpt`

State the design question and constraints for the user to explore interactively. The task param already tells the agent how to brainstorm, not what to brainstorm.
