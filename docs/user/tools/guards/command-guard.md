# Command Guard

Platforms: **Claude Code, ChatGPT, Pi**.

Stop known dangerous shell commands before they run.

## When to use it

Use it when agent work involves Git, package managers, or shell scripts and you want a check against common destructive mistakes.

## Install

```bash
harness install command-guard
```

Add `--platform pi` for Pi or choose another provider with the options in [Get started](../../getting-started.md). Restart your agent or run `/reload` in Pi. Approve Pi project resources when prompted.

## Use it

Restart your agent after installation. Review the installed starter policy and adjust its command patterns and reasons for your repository. A matching command is denied and the agent receives the reason. The starter covers destructive operations, force pushes, credential access, and network content piped into a shell.

Rules inspect command text. Commands hidden inside scripts or unsupported tools can escape this check.

## Limits

This is a guardrail for supported agent tool calls, not a security sandbox. Start the session in the project whose policies you want to use.

See [Configuration](../../configuration.md#guard-policies) for scope and customization.
