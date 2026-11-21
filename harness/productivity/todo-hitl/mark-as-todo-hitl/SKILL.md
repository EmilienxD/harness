---
name: mark-as-todo-hitl
description: Developer-invoked only. Agents must not invoke this skill on their own. Mark deferred code work with a concise TODO(HITL) comment. Use when implementation must wait for a human decision.
argument-hint: "[deferred work]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

At the relevant code location, add the shortest useful comment in the language's native syntax:
`TODO(HITL): <work or human decision still needed>`.

Capture enough context for a later human or agent to understand what remains. Make no other code changes; if the
location or deferred work is ambiguous, ask the developer one concise clarifying question.
