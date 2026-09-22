---
name: address-todo-hitl
description: Investigate and address the most important TODO(HITL) with human agreement. Use when deferred work is ready for a human decision and implementation.
argument-hint: "[TODO(HITL) or scope]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Find the `TODO(HITL)` comments in the current codebase and select the one that appears most important based on its impact, risk, and ability to unblock other work. Use repository evidence only: read the selected
comment and explore its surrounding code, callers, tests, and local documentation until you have found as
many answers as the codebase provides.

Before modifying anything, recommend a concrete resolution and briefly state its scope and material
uncertainties. If the objective is still unclear, ask the user one concise clarifying question instead.
Wait for the user to agree on the resolution.

After agreement, implement and verify the resolution. Remove the selected `TODO(HITL)` comment only when
its work has been addressed. Then rescan the codebase. If another remains, end with: "Would you like to
proceed to the next TODO(HITL): <next most important item and location>?" If none remain, say so briefly.
