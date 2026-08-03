---
name: publish-issues
description: "Publish all drafted issues from .issues-gateway/ to GitHub. Usage: /publish-issues [--dry-run]. --dry-run shows what would be published without creating issues. Creates issues via gh CLI and tracks published issues to avoid duplicates on rerun."
disable-model-invocation: true
---

<!-- Intentionally empty. The UserPromptSubmit hook
     intercepts "/publish-issues" and exits 2 before this content is ever loaded
     into context, so nothing below this line is read by the agent. This file exists
     only so /publish-issues appears in the skill/command listing and autocomplete. -->
