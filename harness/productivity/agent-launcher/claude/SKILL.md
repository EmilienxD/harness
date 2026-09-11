---
name: extend-claude-system-prompt
description: Extend the project-specific Claude Code system prompt used by cch. Use when the user wants to add static or dynamically generated project context to Claude's system prompt.
disable-model-invocation: true
---

# Extend Claude System Prompt

1. Inspect `.harness/agent-launcher/config.py`, `.harness/agent-launcher/system-prompt.md`, and existing modules in `.harness/agent-launcher/extensions/`.
2. For static instructions, edit `system-prompt.md`. For generated context, create a named module under `extensions/`, import it in `config.py`, and use its output only for `claude.system_prompt` in the returned `LaunchConfiguration`.
3. Preserve unrelated user content, `COMMANDS`, and the `chatgpt` configuration. Use only the Python standard library.
4. Run `cch --hns-render` and fix errors until it emits the intended complete prompt.
