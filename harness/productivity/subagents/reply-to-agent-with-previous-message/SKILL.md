---
name: reply-to-agent-with-previous-message
description: User-invoked only. Send this session's previous assistant message unchanged to its parent without generating another response.
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

The runtime hook handles this command before it reaches the agent. It sends the previous assistant message to the pending parent request and blocks the prompt. If there is no previous message or pending parent request, it reports an error to the user and sends nothing.

If these instructions reach the agent, the required hook did not intercept the command. Tell the user to check the installed subagents hooks (the subagents extension on Pi).
