---
name: prototype
description: Open a visible, user-driven aboard prototyper that follows the project's prototype-location convention. Requires a prompt describing the experiment. Available from Manager and brainstormer terminals. Handled entirely by a UserPromptSubmit hook - the body below is an error notice that is only reachable when that hook fails.
argument-hint: "<experiment>"
disable-model-invocation: true
---

**ERROR: Do not run or emulate a prototype. `/prototype` is broken; report that to the user and stop.**

`/prototype` is handled entirely by aboard's `UserPromptSubmit` hook, which should have intercepted the prompt. No prototyper terminal was opened.

Do not try to carry it out yourself: do not perform the experiment in this conversation, choose or create a prototype location, or repair the hook except if the user explicitly asks in a future message. Tell the user that `/prototype` did not run, that it is available only from a live Manager or brainstormer terminal, and that **Update .abd/** reinstalls the owned command skill and hook before they retry.
