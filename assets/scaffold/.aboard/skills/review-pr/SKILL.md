---
name: review-pr
description: Reopen the aboard session that owns the open pull request and hand it to you. Optional trailing text names what to inspect. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
argument-hint: "[what to inspect]"
disable-model-invocation: true
---

**ERROR: Do not resume or review anything. `/review-pr` is broken; report that to the user and stop.**

`/review-pr` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt; the hook is either unregistered, refused this terminal (`/review-pr` is Manager-only), or never ran, and **no session was handed to the user**. The command is a handoff: the extension resumes the session that built the pull request currently in flight and focuses its terminal, and any text typed after `/review-pr` names what that session should look at.

Do not try to carry it out yourself; do not resume that session, do not review the pull request here, and do not fix the hook registration, the settings file, or the extension. You cannot resume that session, and reviewing in its place would produce an opinion detached from the work. Don't try fixing any of it yourself except if the user explicitly asks it in future messages.

For now, just notify the user of this problem:

- `/review-pr` did not run, so no session was resumed or focused. aboard's `UserPromptSubmit` hook should have intercepted it and did not.
- Ask them to open the **aboard** view in VS Code's activity bar and check that the **Agents** panel shows a live Manager (use **+ New Manager** otherwise). The command **Aboard: Review a Pull Request** performs the same handoff and shows a precise error if it fails.
- If a Manager is live and the command still falls through, suggest clicking the **Update .aboard/** button at the top of that view to reinstall aboard's hooks, then retrying `/review-pr`.

Then stop and wait for them.
