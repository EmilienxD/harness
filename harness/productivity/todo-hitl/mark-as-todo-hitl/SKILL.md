---
name: mark-as-todo-hitl
description: Mark deferred code work with a concise TODO(HITL) comment.
disable-model-invocation: true
---

At the relevant code location, add the shortest useful comment in the language's native syntax:
`TODO(HITL): <work or human decision still needed>`.

Capture enough context for a later human or agent to understand what remains. Make no other code changes; if the
location or deferred work is ambiguous, ask the user one concise clarifying question.
