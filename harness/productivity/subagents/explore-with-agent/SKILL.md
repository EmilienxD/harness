---
name: explore-with-agent
description: Launch a read-only agent to explore a codebase and report its findings. Use when the user wants a separate agent to investigate without making changes.
argument-hint: "[exploration task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Explore with an Agent

Follow the delegation workflow injected by the hook, using the persistent conversation inbox. Launch only after the user explicitly requests delegation.

Request parameters: `task: explore`; mode: auto; optional provider: `claude` or `chatgpt`.

Ask the child to inspect the codebase and report findings without editing files.
