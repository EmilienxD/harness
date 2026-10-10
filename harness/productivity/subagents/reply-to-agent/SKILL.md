---
name: reply-to-agent
description: User-invoked only. Agents must not invoke this skill on their own. Conclude the current agent session with a self-contained result. Use when the work must return to and continue in the parent session.
argument-hint: "[conclusion focus]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

The user wants to reply to an agent who depends on your work. Give them a self-contained conclusion that allows it to understand this session's work and its result.

Restate the task or question precisely enough for the conclusion to stand alone, then lead with its answer or outcome. Explain what you did and how, including consequential decisions or assumptions; identify the resulting artifacts by exact path or URL; report the verification performed and its result; and state any incomplete work, unresolved concern, or necessary next action. Clearly distinguish completed work from recommendations.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the agent's context, saving tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45). Do not append them to the file path (e.g., @src/core.py:25); that format is not supported. If relevant code is not saved in the project, include the necessary parts as small snippets.

If the user supply additional text in argument, treat as a guidance about what the conclusion should emphasize.

The response is complete when a reader can determine what was asked, what was accomplished, how and where it was done, how it was verified, and what remains.
