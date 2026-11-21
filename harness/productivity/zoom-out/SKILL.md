---
name: zoom-out
description: Developer-invoked only. Agents must not invoke this skill on their own. Tell the agent to zoom out and give broader context or a higher-level perspective. Use when the developer is unfamiliar with a section of code or needs to understand how it fits into the bigger picture.
argument-hint: "[code area]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

I don't know this area of code well. Go up a layer of abstraction. Give me a map of all the relevant modules and callers, using the project's domain glossary vocabulary.
