---
name: auto
description: Start aboard's automatic implementation run for the oldest open spec issue. Takes no arguments. Intentionally empty - handled entirely by a UserPromptSubmit hook, no model call.
disable-model-invocation: true
---

<!-- Intentionally empty. The UserPromptSubmit hook intercepts "/auto" and exits 2
     before this content is ever loaded into context, so nothing below this line
     is read by the agent. This file exists only so /auto appears in the
     skill/command listing and autocomplete.

     The command takes no arguments on purpose: the extension resolves the spec,
     its processable children, and their dispositions from GitHub, so there is
     nothing for the caller to supply. -->
