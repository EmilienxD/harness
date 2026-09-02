---
name: queue
description: Queue a message for a new visible general-purpose Claude session. The first task starts only from a clean working tree; each later task waits for the preceding task to finish, a new commit, and a clean tree. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
argument-hint: "<message>"
disable-model-invocation: true
---

**ERROR: Do not queue or perform this task. `/queue` is broken — report that to the user and stop.**

`/queue` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt. No general-purpose session was queued or launched. The extension owns this FIFO because it must observe the real Git working tree and commit boundary before opening each visible terminal.

Do not try to carry it out yourself, do not act as the general-purpose session, and do not fix the hook registration, settings, or extension. You cannot reproduce the queue's clean-tree and new-commit gate from this conversation. Don't try fixing any of it yourself except if the user explicitly asks in a future message.

Tell the user that `/queue` did not run, ask them to confirm that the **Agents** panel has a live Manager, and suggest **Update .aboard/** if the Manager is live but the command still falls through. Then stop and wait for them.
