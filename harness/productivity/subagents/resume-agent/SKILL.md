---
name: resume-agent
description: Continue an exited delegated agent with a next message in its existing conversation.
argument-hint: "agent-i next message"
license: MIT
disable-model-invocation: true
---

# Resume an Agent

Follow the shared delegation workflow injected by the hook. Resolve the user-selected agent-i identifier in this parent conversation and write a fresh request file with only `resume: agent-i` in frontmatter and the user's nonempty next message as its body.

The runtime preserves provider, execution mode, directory, conversation, and identifier. If resume is refused because an execution is live or uncertain, report the refusal and wait for the user to close or verify that execution.
