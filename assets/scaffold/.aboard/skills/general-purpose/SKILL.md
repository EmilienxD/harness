---
name: general-purpose
description: Open a visible aboard session using Claude Code's unmodified default agent. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
disable-model-invocation: true
---

**ERROR: Do not open or emulate a session. `/general-purpose` is broken; report that to the user and stop.**

`/general-purpose` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt; the hook is either unregistered, refused this terminal (`/general-purpose` is Manager-only), or never ran, and **no general-purpose session was opened**. The whole point of this command is that the extension performs it: it spawns a separate visible terminal running Claude Code's unmodified default agent, which the user drives directly, while the Manager stays out of it.

Do not try to carry it out yourself, do not act as the general-purpose session, and do not fix the hook registration, the settings file, or the extension; you cannot spawn that terminal, and continuing here would silently replace what the user asked for. Don't try fixing any of it yourself except if the user explicitly asks in a future message.

For now, just notify the user of this problem:

- `/general-purpose` did not run, so no session was opened. aboard's `UserPromptSubmit` hook should have intercepted it and did not.
- Ask them to open the **aboard** view in VS Code's activity bar and check that the **Agents** panel shows a live Manager (use **+ New Manager** otherwise).
- If a Manager is live and the command still falls through, suggest clicking the **Update .aboard/** button at the top of that view to reinstall aboard's hooks, then retrying `/general-purpose`.

Then stop and wait for them.
