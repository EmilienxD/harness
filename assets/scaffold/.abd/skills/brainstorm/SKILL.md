---
name: brainstorm
description: Open a visible aboard brainstorm session for direct conversation. Takes no arguments. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
disable-model-invocation: true
---

**ERROR: Do not open or emulate a session. `/brainstorm` is broken; report that to the user and stop.**

`/brainstorm` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt; the hook is either unregistered, refused this terminal (`/brainstorm` is available only from a live Manager or brainstormer terminal), or never ran, and **no brainstorm session was opened**. The whole point of this command is that the extension performs it: it spawns a separate visible terminal that the user talks to directly, and the agent (you) stays out of it.

Do not try to carry it out yourself, do not brainstorm here instead, and do not fix the hook registration, the settings file, or the extension; you cannot spawn that terminal, and holding the conversation in this session would silently replace what the user asked for. Don't try fixing any of it yourself except if the user explicitly asks it in future messages.

For now, just notify the user of this problem:

- `/brainstorm` did not run, so no session was opened. aboard's `UserPromptSubmit` hook should have intercepted it and did not.
- Ask them to open the **aboard** view in VS Code's activity bar and check that the **Agents** panel shows a live Manager (use **+ New Manager** otherwise).
- If a Manager or brainstormer is live and the command still falls through, suggest clicking the **Update .abd/** button at the top of that view to reinstall aboard's hooks, then retrying `/brainstorm`.

Then stop and wait for them.
