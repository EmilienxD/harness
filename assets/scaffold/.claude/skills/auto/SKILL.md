---
name: auto
description: Start aboard's automatic implementation run for the oldest open spec issue. Takes no arguments. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
disable-model-invocation: true
---

**ERROR: Do not start or emulate a run. `/auto` is broken — report that to the user and stop.**

`/auto` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt — the hook is either unregistered, refused this terminal (`/auto` is Manager-only), or never ran, and **no run was started**. Only the extension can start an automatic implementation run: it resolves the spec issue and its children and owns every branch, commit, push, and pull request. Nothing an agent does from a session would be the real thing.

Do not try to carry it out yourself — do not start implementing the spec, and do not fix the hook registration, the settings file, or the extension — except if the user explicitly asks for that in future messages.

For now, just notify the user of this problem:

- `/auto` did not run, so no run was started. aboard's `UserPromptSubmit` hook should have intercepted it and did not.
- Ask them to open the **aboard** view in VS Code's activity bar and check that the **Agents** panel shows a live Manager (use **+ New Manager** otherwise). The command **Aboard: Start Auto Run** performs the same action and shows a precise error if it is refused.
- If a Manager is live and the command still falls through, suggest clicking the **Reset .aboard/** button at the top of that view to reinstall aboard's hooks, then retrying `/auto`.

Then stop and wait for them.
