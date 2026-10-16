---
name: brainstorm-with-agent
description: User-invoked only. Agents must not invoke this skill on their own. Launch an interactive agent to brainstorm a plan or design with the user. Use when the user wants a separate agent to question, clarify, or stress-test their thinking.
argument-hint: "[topic]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run a subagent with the `brainstorm` task.

Invoke the `subagents-toolkit` skill if its instructions are not already in the current context, then follow its workflow using the conversation inbox supplied by the runtime.

Request parameters:
- task: brainstorm
- mode: interactive
- provider (Optional): claude, chatgpt, codex (alias of chatgpt), or pi
- model (Optional): model ID
- root (Optional): existing directory or worktree path, only when the user explicitly requests another root

State the design question and constraints for the user to explore interactively. The task param already tells the agent how to brainstorm, not what to brainstorm.
