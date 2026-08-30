---
name: done
description: Close this visible aboard terminal and report the last complete assistant message to the session that launched it. Optional trailing text is included as further notes, not as a replacement for that report. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
argument-hint: "[further notes]"
disable-model-invocation: true
---

**ERROR: Do not close or kill anything. `/done` is broken — report that to the user and stop.**

`/done` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt — the hook is either unregistered, does not apply to this terminal, or never ran, and **this terminal was not closed**. Closing an aboard terminal is the extension's job: it releases the session's write lease and records the end.

Do not try to carry it out yourself — do not exit or kill your own process, tell the user their session is done, or fix the hook registration, the settings file, or the extension. Exiting from here would strand the lease state. Don't try fixing any of it yourself except if the user explicitly asks it in future messages.

For now, just notify the user of this problem:

- `/done` did not run, so this terminal is still open. aboard's `UserPromptSubmit` hook should have intercepted it and did not.
- Ask them to open the **aboard** view in VS Code's activity bar and check that the **Agents** panel shows this agent; killing it from there is the manual equivalent.
- If the agent is listed and the command still falls through, suggest clicking the **Update .aboard/** button at the top of that view to reinstall aboard's hooks, then retrying `/done`.

Then stop and wait for them.
