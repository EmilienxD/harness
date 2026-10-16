---
name: websearch-with-agent
description: User-invoked only. Agents must not invoke this skill on their own. Launch an agent to research the web and report sourced findings. Use when the user wants a separate agent to investigate current or externally documented information.
argument-hint: "[research task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run a subagent with the `websearch` task.

Invoke the `subagents-toolkit` skill if its instructions are not already in the current context, then follow its workflow using the conversation inbox supplied by the runtime.

Request parameters:
- task: websearch
- mode: interactive or auto (default auto)
- provider (Optional): claude, chatgpt, codex (alias of chatgpt), or pi
- model (Optional): model ID
- root (Optional): existing directory or worktree path, only when the user explicitly requests another root

State the research question, source requirements, and requested output. The task param already tells the agent how to websearch, not what to websearch.
