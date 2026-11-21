---
name: decisions
description: Developer-invoked only. Agents must not invoke this skill on their own. Review important decisions made during the current work and surface only those where confidence remains low.
argument-hint: "[focus]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Review the work completed in this conversation. Report only important decisions where confidence remains low and a materially better alternative may exist.

For each one, briefly state the decision, why it is uncertain, and the strongest alternative. Omit decisions that already have a clearly best solution. If none remain, say so.

Answer concisely in plain English.
