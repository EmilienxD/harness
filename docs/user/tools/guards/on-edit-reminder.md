# On Edit Reminder

Platforms: **Claude Code, ChatGPT, Pi**.

Remind the agent to consult guidance after a matching edit.

## When to use it

Use it when you want convention checks without blocking the first edit.

## Install

```bash
harness install on-edit-reminder
```

Add `--platform pi` for Pi or choose another provider with the options in [Get started](../../getting-started.md). Restart your agent or run `/reload` in Pi. Approve Pi project resources when prompted.

## Use it

Configure the affected paths and the guidance associated with them. The edit is allowed, then the agent is told to read the guidance and correct any mismatch. Use On Edit Block instead when the guidance must be read first.

## Limits

This is a guardrail for supported agent tool calls, not a security sandbox. Start the session in the project whose policies you want to use.

See [Configuration](../../configuration.md#guard-policies) for scope and customization.
