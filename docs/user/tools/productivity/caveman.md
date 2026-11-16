# Caveman

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install caveman`. See [installation and scope](../../getting-started.md).

## Use it

Use `caveman` when you want terse answers while keeping technical details, exact error text, and code intact. Invoke `/caveman` in Claude Code or `$caveman` in ChatGPT, optionally followed by a request.

## What happens

The style persists across subsequent replies. Say “stop caveman” or “normal mode” to turn it off. The agent temporarily uses fuller wording for safety warnings, irreversible actions, or instructions that would be unclear as fragments.

## Practical note

The skill shortens filler, articles, and pleasantries, and may use fragments, abbreviations, and arrows. It does not alter code blocks or quoted errors.

If a terse explanation is hard to follow, ask for clarification. The skill permits a clearer answer before returning to the compressed style.

## Pi usage

Use `/skill:caveman`. The shared response-style skill is installed at project and user scope.
