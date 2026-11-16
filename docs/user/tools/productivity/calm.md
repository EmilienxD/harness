# Calm

Platforms: **Pi**.

Reduce transcript noise while keeping tool activity visible.

## Install

```bash
harness install calm --platform pi
```

Add `--scope user` to use it across projects.

See [Get started](../../getting-started.md) for installation options.

## Use it

After installation, tool calls appear in compact temporary blocks. Each block shows the command, path, or query being used. A spinner indicates running work. Green and red markers indicate success and failure. Completed tool blocks disappear after three seconds. Tool output and diffs are hidden from the transcript, not from the agent. Disable Calm when you want to inspect full tool output again.
