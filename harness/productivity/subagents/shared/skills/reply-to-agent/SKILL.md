---
name: reply-to-agent
description: Conclude the current session so its work can continue in the parent session.
disable-model-invocation: true
---

# Reply To Agent

The user wants to end this session and continue in the parent agent session. Give them a self-contained conclusion that lets someone without this conversation understand the work and its result.

Restate the task or question precisely enough for the conclusion to stand alone, then lead with its answer or outcome. Explain what you did and how, including consequential decisions or assumptions; identify the resulting artifacts by exact path or URL; report the verification performed and its result; and state any incomplete work, unresolved concern, or necessary next action. Clearly distinguish completed work from recommendations.

Reference files as `@absolute/or/relative/to/the/project/root/path`. Prefixing a path with `@` loads the file directly into the agent's context, saving Read tool calls, time, and tokens. Refer to line numbers in plain text (e.g., lines 14-45); do not append them to the file path (e.g., @src/core.py:25), because that format is not supported.

Prefer references to existing artifacts over reproducing their contents. Include only the conversation details needed to understand the result rather than recounting the session.

Treat text supplied with the invocation as guidance about what the conclusion should emphasize.

The response is complete when a reader can determine what was asked, what was accomplished, how and where it was done, how it was verified, and what remains.
