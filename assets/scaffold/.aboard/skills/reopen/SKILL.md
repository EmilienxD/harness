---
name: reopen
description: Reopen an aboard session that has ended - a brainstormer, a general-purpose session, or a pr-doctor - and hand its terminal back to the user. Optional trailing text names an agent id or an agent type. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
argument-hint: "[agent id or agent type]"
disable-model-invocation: true
---

**ERROR: Do not resume anything. `/reopen` is broken; report that to the user and stop.**

`/reopen` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt; the hook is either unregistered, refused this terminal (`/reopen` is Manager-only), or never ran, and **no session was reopened**. The command is a handoff: the extension finds the recorded session, re-emits the agent definition it was launched from, resumes the Claude conversation under the same session id, and focuses the new terminal.

Do not try to carry it out yourself. You cannot reopen that session: resuming it needs the per-launch agent definition the extension rewrites and points at with `--add-dir`, and a bare `claude --resume` restores the conversation onto Claude Code's default persona with the wrong tools. Do not run it, do not emulate the agent that was in that conversation, and do not fix the hook registration, the settings file, or the extension. Don't try fixing any of it yourself except if the user explicitly asks it in future messages.

For now, just notify the user of this problem:

- `/reopen` did not run, so no session was reopened. aboard's `UserPromptSubmit` hook should have intercepted it and did not.
- Ask them to open the **aboard** view in VS Code's activity bar and check that the **Agents** panel shows a live Manager (use **+ New Manager** otherwise). The command **Aboard: Reopen a Session** performs the same handoff, lists every session that can be reopened, and shows a precise error if it fails.
- If a Manager is live and the command still falls through, suggest clicking the **Update .aboard/** button at the top of that view to reinstall aboard's hooks, then retrying `/reopen`.

Then stop and wait for them.
