---
name: resume-agent
description: Continue a delegated agent with a next message in its existing conversation.
argument-hint: "agent-i next message"
license: MIT
disable-model-invocation: true
---

# Resume an Agent

Follow the shared delegation workflow and inbox supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Resolve the user-selected agent-i identifier in this parent conversation and write a fresh request file with only `resume: agent-i` in frontmatter and the user's nonempty next message as its body.

The agent keeps its task, provider, execution mode, directory, and identifier, and continues even while its session is still open. Report a failed continuation with the reason the runtime gives.
