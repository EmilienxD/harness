---
name: resume-agent
description: Continue a delegated agent with a next message in its existing conversation.
argument-hint: "[agent-i] [resume focus]"
license: MIT
disable-model-invocation: true
---

Resume the subagent from where it finished by sending a follow-up message to its existing conversation. Use any supplied arguments as the focus for the continuation. Resuming preserves the agent's conversation context. State the next objective, relevant new findings, and completion criteria.

Follow the *Multi Provider Subagent System Guideline* previously supplied by the hook. If no hook supplied them, stop immediately and notify the user without looking for a workaround.

Use an explicit `agent-i` if supplied; otherwise select the only subagent in this parent conversation, or infer the intended one from the user's focus and the agents' prior tasks and results. Ask which agent only when the context leaves multiple or no plausible matches.
