---
name: address-with-agent
description: Launch a agent to implement and validate a bounded change. Use when the user wants a separate agent to perform the work.
argument-hint: "[implementation task]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Address with an Agent

Follow the delegation workflow injected by the hook, using the persistent conversation inbox. Launch only after the user explicitly requests delegation.

Request parameters: `task: implement`; mode: interactive or auto (default auto); optional provider: `claude` or `chatgpt`.

Determine the work from the user's request and the preceding conversation. When the invocation provides no new instructions, use the subject already under discussion and any description supplied as an argument. If neither the invocation nor prior messages establishes what the new agent should do, ask the user before writing the request; never launch an agent without a clear task.

Describe the bounded change and its validation criteria. The runtime selects the address-this workflow.
