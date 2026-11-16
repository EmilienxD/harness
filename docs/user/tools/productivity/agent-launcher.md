# Agent launcher

Platforms: **Claude Code, ChatGPT**.

Install with `harness install agent-launcher`. See [Get started](../../getting-started.md) for provider and scope options.

## When to use it

Launch Claude Code or Codex with repeatable project-specific settings. Keep your usual launch commands short.

## Use it

Run `cch` for Claude Code or `cxh` for Codex. Run `cch --hns-init` or `cxh --hns-init` from a project to create its starter configuration. Review the generated settings before launching an agent. Use `/extend-claude-system-prompt` in Claude Code when you want help updating its extra instructions. The launcher searches from your working directory up to the nearest Git root for project settings.

Install and authenticate the underlying agent first.
