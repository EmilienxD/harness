---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Explicit invocation only.
disable-model-invocation: true
---

Write a handoff, detailed document as a markdown block inline in the chat summarising the current conversation so a fresh agent can continue the work.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user provided details alongside the invocation, treat them as a description of what the next session will focus on and tailor the doc accordingly.
