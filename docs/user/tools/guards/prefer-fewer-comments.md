# Prefer Fewer Comments

Platforms: **Claude Code, ChatGPT, Pi**.

Encourage concise comments and docstrings in newly written code.

## When to use it

Use it when agent-generated explanations are cluttering otherwise readable code.

## Install

```bash
harness install prefer-fewer-comments
```

Add `--platform pi` for Pi or choose another provider with the options in [Get started](../../getting-started.md). Restart your agent or run `/reload` in Pi. Approve Pi project resources when prompted.

## Use it

Review the installed comment-budget policy and adjust limits for your project. The tool reports commentary that exceeds the configured budget. Treat the feedback as guidance. It does not block the edit. Keep comments that explain non-obvious constraints or important reasoning. Shell writes and unsupported custom tools may not receive the same feedback.

## Limits

This is a guardrail for supported agent tool calls, not a security sandbox. Start the session in the project whose policies you want to use.

See [Configuration](../../configuration.md#guard-policies) for scope and customization.
