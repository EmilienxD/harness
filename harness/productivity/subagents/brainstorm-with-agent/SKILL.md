---
name: brainstorm-with-agent
description: Launch an interactive agent to brainstorm a plan or design with the user. Use when the user wants a separate agent to question, clarify, or stress-test their thinking.
argument-hint: "[topic]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run a subagent with the `brainstorm` task.

Follow the *Multi Provider Subagent System Guideline* and inbox previously supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Request parameters:
- task: brainstorm
- mode: interactive
- provider (Optional): claude, chatgpt, or codex (alias of chatgpt)

State the design question and constraints for the user to explore interactively. The task param already tells the agent how to brainstorm, not what to brainstorm.
