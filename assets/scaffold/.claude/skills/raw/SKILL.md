---
name: raw
description: Open a visible aboard session with no agent definition. Takes no arguments. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
disable-model-invocation: true
---

**ERROR: Do not open or emulate a session. `/raw` is broken — report that to the user and stop.**

`/raw` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt — the hook is either unregistered, refused this terminal (`/raw` is Manager-only), or never ran, and **no raw session was opened**. The whole point of this command is that the extension performs it: it spawns a separate visible terminal that the user drives directly, and the agent (you) stays out of it.

Do not try to carry it out yourself, do not act as the raw session, and do not fix the hook registration, the settings file, or the extension — you cannot spawn that terminal, and continuing here would silently replace what the user asked for. Don't try fixing any of it yourself except if the user explicitly asks it in future messages.

For now, just notify the user of this problem:

- `/raw` did not run, so no session was opened. aboard's `UserPromptSubmit` hook should have intercepted it and did not.
- Ask them to open the **aboard** view in VS Code's activity bar and check that the **Agents** panel shows a live Manager (use **+ New Manager** otherwise).
- If a Manager is live and the command still falls through, suggest clicking the **Reset .aboard/** button at the top of that view to reinstall aboard's hooks, then retrying `/raw`.

Then stop and wait for them.
