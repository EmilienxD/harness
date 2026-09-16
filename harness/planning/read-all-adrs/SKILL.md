---
name: read-all-adrs
description: Load every project ADR to establish complete decision context. Use when the user explicitly asks to read all ADRs.
argument-hint: "[focus]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Read every ADR `.md` file in this project's `docs/adr/` folder from start to
finish.

Read each file in full so every documented architectural decision informs the
current work.
