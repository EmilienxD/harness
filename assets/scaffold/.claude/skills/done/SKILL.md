---
name: done
description: Close this visible aboard terminal. Takes no arguments. Intentionally empty - handled entirely by a UserPromptSubmit hook, no model call.
disable-model-invocation: true
---

<!-- Intentionally empty. The UserPromptSubmit hook intercepts "/done" and exits
     2 before this content is ever loaded into context, so nothing below this
     line is read by the agent. This file exists only so /done appears in the
     skill/command listing and autocomplete. -->
