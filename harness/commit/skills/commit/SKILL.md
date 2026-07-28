---
name: commit
description: "Git commit the changes during the session. Intentionally empty - handled entirely by a UserPromptSubmit hook, no model call."
disable-model-invocation: true
---

<!-- Intentionally empty. The UserPromptSubmit hook
     intercepts "/commit" and exits 2 before this content is ever loaded
     into context, so nothing below this line is read by the agent. This file exists
     only so /commit appears in the skill/command listing and autocomplete. -->
