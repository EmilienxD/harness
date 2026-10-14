---
name: prototype-with-agent
description: User-invoked only. Agents must not invoke this skill on their own. Launch an agent to build a focused prototype. Use when the user wants a separate agent to test an idea through a disposable implementation.
argument-hint: "[prototype task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run a subagent with the `prototype` task.

Invoke the `subagents-toolkit` skill if its instructions are not already in the current context, then follow its workflow using the conversation inbox supplied by the hook.

Request parameters:
- task: prototype
- mode: interactive
- provider (Optional): claude, chatgpt, or codex (alias of chatgpt)
- model (Optional): model ID
- root (Optional): existing directory or worktree path, only when the user explicitly requests another root

Describe the disposable experiment and its success criteria. The task param already tells the agent how to prototype, not what to prototype.
