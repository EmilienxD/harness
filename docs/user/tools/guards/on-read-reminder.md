# On Read Reminder

Platforms: **Claude Code, ChatGPT, Pi**.

Point the agent to relevant guidance when it reads matching paths.

## When to use it

Use it to make domain context easier to discover during exploration.

## Install

```bash
harness install on-read-reminder
```

Add `--platform pi` for Pi or choose another provider with the options in [Get started](../../getting-started.md). Restart your agent or run `/reload` in Pi. Approve Pi project resources when prompted.

## Use it

Configure path patterns and the guidance to recommend for each match. When the agent reads a matching path, it receives the reminder. Use exclusions to avoid reminders for irrelevant paths. This is a reminder, not an editing restriction.

## Limits

This is a guardrail for supported agent tool calls, not a security sandbox. Start the session in the project whose policies you want to use.

See [Configuration](../../configuration.md#guard-policies) for scope and customization.
