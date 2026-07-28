---
name: publish-issues
description: Publish drafted issues from .issues-gateway/ with gh. Intentionally empty - handled entirely by a UserPromptSubmit hook, no model call.
disable-model-invocation: true
---

<!-- Intentionally empty. The UserPromptSubmit hook
     intercepts "/publish-issues" and exits 2 before this content is ever loaded
     into context, so nothing below this line is read by the agent. This file exists
     only so /publish-issues appears in the skill/command listing and autocomplete. -->
