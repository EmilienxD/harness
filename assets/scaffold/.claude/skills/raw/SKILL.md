---
name: raw
description: Open a visible aboard session with no agent definition. Takes no arguments. Intentionally empty - handled entirely by a UserPromptSubmit hook, no model call.
disable-model-invocation: true
---

<!-- Intentionally empty. The UserPromptSubmit hook
     intercepts "/raw" and exits 2 before this content is ever loaded
     into context, so nothing below this line is read by the agent. This file exists
     only so /raw appears in the skill/command listing and autocomplete.

     The command takes no arguments on purpose: it opens an interactive terminal
     that the user drives directly, so there is no opening message to send. -->
