---
name: resume-agent
description: Continue a delegated agent with a next message in its existing conversation.
argument-hint: "agent-i next message"
license: MIT
disable-model-invocation: true
---

Resume the agent the user asked to resume.

Follow the *Multi Provider Subagent System Guideline* previously supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Resolve the user-selected `agent-i` where `i` is the id in this parent conversation, and write a fresh request file with only `resume: agent-i` in frontmatter and the nonempty next message as its body.

The agent keeps its task, provider, execution mode, directory, and id.
