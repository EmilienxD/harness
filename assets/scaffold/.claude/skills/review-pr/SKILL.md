---
name: review-pr
description: Reopen the aboard session that owns the open pull request and hand it to you. Takes no arguments. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
disable-model-invocation: true
---

<!-- The body is an error notice on purpose. aboard's UserPromptSubmit hook
     intercepts "/review-pr" and exits 2, so this file is normally never
     loaded. Reaching it means the hook failed, and an empty body would leave
     the model to invent a response. -->

**This text should not have reached you.** `/review-pr` is handled by aboard's `UserPromptSubmit` hook, which performs the command and erases the prompt before this file is ever read. If you are reading it, the hook did not run and **no session was handed to the user**.

Do not try to carry it out yourself, and do not review the pull request here. The command is a handoff: the extension resumes the session that built the pull request currently in flight and focuses its terminal. You cannot resume that session, and reviewing in its place would produce an opinion detached from the work.

Tell the user instead:

- `/review-pr` did not run, because aboard's `UserPromptSubmit` hook did not intercept it. No session was resumed or focused.
- Likely causes: this terminal was not started by aboard (no `ABOARD_AGENT_ID`), or it is not the Manager terminal — `/review-pr` is Manager-only; the hook is missing from the `UserPromptSubmit` registrations in `.claude/settings.json`; `uv` is not on `PATH`; or the aboard extension is not running.
- They need to fix that and retry.

Then stop and wait for them.
