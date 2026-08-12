---
name: done
description: Close this visible aboard terminal. Takes no arguments. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
disable-model-invocation: true
---

<!-- The body is an error notice on purpose. aboard's UserPromptSubmit hook
     intercepts "/done" and exits 2, so this file is normally never loaded.
     Reaching it means the hook failed, and an empty body would leave the model
     to invent a response. -->

**This text should not have reached you.** `/done` is handled by aboard's `UserPromptSubmit` hook, which performs the command and erases the prompt before this file is ever read. If you are reading it, the hook did not run and **this terminal was not closed**.

Do not try to carry it out yourself. Closing an aboard terminal is the extension's job — it releases the session's write lease and records the end. Exiting or killing the process from here would strand that state.

Tell the user instead:

- `/done` did not run, because aboard's `UserPromptSubmit` hook did not intercept it. The terminal is still open.
- Likely causes: this terminal was not started by aboard (no `ABOARD_AGENT_ID`), so aboard's hooks skip it; the hook is missing from the `UserPromptSubmit` registrations in `.claude/settings.json`; `uv` is not on `PATH`; or the aboard extension is not running.
- They need to fix that and retry.

Then stop and wait for them.
