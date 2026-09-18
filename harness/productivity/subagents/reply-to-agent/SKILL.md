---
name: reply-to-agent
description: Communicates a report to the parent agent. Use when the work must return to and continue in the parent session.
argument-hint: "[conclusion focus]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Hand off your work to an agent who depends on it. Give this agent a self-contained report that allows it to understand this session's work and its result since the latest reply-to-agent skill invokation (or from the beginning of the conversation if this is the first invokation).

If the user supply additional text in argument, treat as a guidance about what the conclusion should emphasize.

Reference files by giving there paths. If relevant code is not accessible on the codebase, include the necessary parts as small snippets.