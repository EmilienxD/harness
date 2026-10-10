---
name: explore-with-agent
description: User-invoked only. Agents must not invoke this skill on their own. Launch a read-only agent to explore a codebase and report its findings. Use when the user wants a separate agent to investigate without making changes.
argument-hint: "[exploration task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run a subagent with the `explore` task.

Invoke the `subagents-toolkit` skill if its instructions are not already in the current context, then follow its workflow using the conversation inbox supplied by the hook.

Request parameters:
- task: explore
- mode: auto
- provider (Optional): claude, chatgpt, or codex (alias of chatgpt)

Ask the child to inspect the codebase and report findings without editing files. The task param already tells the agent how to explore, not what to explore.
