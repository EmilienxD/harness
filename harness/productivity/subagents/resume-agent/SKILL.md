---
name: resume-agent
description: User-invoked only. Agents must not invoke this skill on their own. Continue a delegated agent with a next message in its existing conversation.
argument-hint: "agent-i next message"
license: MIT
disable-model-invocation: true
---

Resume the agent the user asked to resume.

Invoke the `subagents-toolkit` skill if its instructions are not already in the current context, then follow its workflow using the conversation inbox supplied by the hook.

Resolve the user-selected `agent-i` where `i` is the id in this parent conversation, and write a fresh request file with only `resume: agent-i` in frontmatter and the nonempty next message as its body.

The agent keeps its task, provider, execution mode, directory, and id.
