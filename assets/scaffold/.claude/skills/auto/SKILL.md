---
name: auto
description: Start aboard's automatic implementation run for the oldest open spec issue. Takes no arguments. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
disable-model-invocation: true
---

<!-- The body is an error notice on purpose. aboard's UserPromptSubmit hook
     intercepts "/auto" and exits 2, so this file is normally never loaded.
     Reaching it means the hook failed, and an empty body would leave the model
     to invent a response. -->

**This text should not have reached you.** `/auto` is handled by aboard's `UserPromptSubmit` hook, which performs the command and erases the prompt before this file is ever read. If you are reading it, the hook did not run and **the command was not performed**.

Do not try to carry it out yourself. Only the extension can start an automatic implementation run — it resolves the spec issue and its children, and it owns every branch, commit, push, and pull request. Nothing you can do from here would be the real thing.

Tell the user instead:

- `/auto` did not run, because aboard's `UserPromptSubmit` hook did not intercept it. No run was started.
- Likely causes: this terminal was not started by aboard (no `ABOARD_AGENT_ID`), or it is not the Manager terminal — `/auto` is Manager-only; the hook is missing from the `UserPromptSubmit` registrations in `.claude/settings.json`; `uv` is not on `PATH`; or the aboard extension is not running.
- They need to fix that and retry.

Then stop and wait for them.
