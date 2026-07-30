---
name: update-todo
description: Evolve the aboard project TODO issue while preserving it as a concise roadmap
argument-hint: "[roadmap change]"
disable-model-invocation: true
allowed-tools: mcp__aboard__get_todo, mcp__aboard__update_todo
---

Read the current project roadmap with `aboard__get_todo`. Apply `$ARGUMENTS` as an evolution of that roadmap: add newly discovered work, reprioritize existing work, and remove obsolete items. Keep it concise and directional rather than duplicating specification issues. Replace the body with `aboard__update_todo`, and give a short audit reason.
