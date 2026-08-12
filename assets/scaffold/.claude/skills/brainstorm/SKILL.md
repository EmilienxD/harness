---
name: brainstorm
description: Open a visible aboard brainstorm session for direct conversation. Takes no arguments. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
disable-model-invocation: true
---

<!-- The body is an error notice on purpose. aboard's UserPromptSubmit hook
     intercepts "/brainstorm" and exits 2, so this file is normally never
     loaded. Reaching it means the hook failed, and an empty body would leave
     the model to invent a response. -->

**This text should not have reached you.** `/brainstorm` is handled by aboard's `UserPromptSubmit` hook, which performs the command and erases the prompt before this file is ever read. If you are reading it, the hook did not run and **no brainstorm session was opened**.

Do not try to carry it out yourself, and do not brainstorm here instead. The command opens a separate visible terminal that the user talks to directly; you cannot spawn one, and holding the conversation in this session would silently replace what they asked for.

Tell the user instead:

- `/brainstorm` did not run, because aboard's `UserPromptSubmit` hook did not intercept it. No session was opened.
- Likely causes: this terminal was not started by aboard (no `ABOARD_AGENT_ID`), or it is not the Manager terminal — `/brainstorm` is Manager-only; the hook is missing from the `UserPromptSubmit` registrations in `.claude/settings.json`; `uv` is not on `PATH`; or the aboard extension is not running.
- They need to fix that and retry.

Then stop and wait for them.
