---
name: websearch-with-agent
description: Launch a agent to research the web and report sourced findings. Use when the user wants a separate agent to investigate current or externally documented information.
argument-hint: "[research task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Websearch with an Agent

Follow the delegation workflow injected by the hook, using the persistent conversation inbox. Launch only after the user explicitly requests delegation.

Request parameters: `task: websearch`; mode: interactive or auto (default auto); optional provider: `claude` or `chatgpt`.

State the research question, source requirements, and requested output. The runtime selects the websearch workflow.
