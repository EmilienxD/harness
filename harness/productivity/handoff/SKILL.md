---
name: handoff
description: User-invoked only. Agents must not invoke this skill on their own. Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "[next-session focus]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user provided details alongside the invocation, treat them as a description of what the next session will focus on and tailor the doc accordingly.
