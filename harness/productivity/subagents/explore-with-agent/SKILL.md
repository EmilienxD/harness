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

Follow the shared delegation workflow and inbox supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Request parameters:
- task: explore
- mode:auto
- provider (Optional): `claude` or `chatgpt`

Ask the child to inspect the codebase and report findings without editing files. The task param already tells the agent how to explore, not what to address.
