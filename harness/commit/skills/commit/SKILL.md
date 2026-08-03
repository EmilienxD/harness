---
name: commit
description: "Create a git commit with staged and unstaged changes. Usage: /commit [--dry] [--ai] [message]. --dry shows what would happen without committing. --ai generates the message from the diff (makes message optional; any text after becomes guidance). Without flags, message is required."
disable-model-invocation: true
---

<!-- Intentionally empty. The UserPromptSubmit hook
     intercepts "/commit" and exits 2 before this content is ever loaded
     into context, so nothing below this line is read by the agent. This file exists
     only so /commit appears in the skill/command listing and autocomplete. -->
