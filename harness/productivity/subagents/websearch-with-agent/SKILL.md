---
name: websearch-with-agent
description: Launch an agent to research the web and report sourced findings. Use when the user wants a separate agent to investigate current or externally documented information.
argument-hint: "[research task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Run a subagent with the `websearch` task.

Follow the *Multi Provider Subagent System Guideline* and inbox previously supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Request parameters:
- task: websearch
- mode: interactive or auto (default auto)
- provider (Optional): claude, chatgpt, or codex (alias of chatgpt)

State the research question, source requirements, and requested output. The task param already tells the agent how to websearch, not what to websearch.
