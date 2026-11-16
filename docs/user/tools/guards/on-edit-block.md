# On Edit Block

Platforms: **Claude Code, ChatGPT, Pi**.

Require the agent to read guidance before changing matching paths.

## When to use it

Use it for areas where conventions or architectural decisions must be understood before editing.

## Install

```bash
harness install on-edit-block
```

Add `--platform pi` for Pi or choose another provider with the options in [Get started](../../getting-started.md). Restart your agent or run `/reload` in Pi. Approve Pi project resources when prompted.

## Use it

Configure path patterns and the guidance that must be read for each pattern.

For example, require architecture guidance before editing the data model. A matching edit is denied until the required guidance has been read in the session. Use exclusions for generated or third-party content. Keep required guidance accessible and reasonably short.

## Limits

This is a guardrail for supported agent tool calls, not a security sandbox. Start the session in the project whose policies you want to use.

See [Configuration](../../configuration.md#guard-policies) for scope and customization.
