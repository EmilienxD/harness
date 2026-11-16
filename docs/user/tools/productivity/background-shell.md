# Background shell

Platforms: **Pi**.

Run a long shell command while the agent continues other work.

## Install

```bash
harness install background-shell --platform pi
```

Add `--scope user` to use it across projects.

See [Get started](../../getting-started.md) for installation options.

## Use it

Ask the agent to run a long command in the background. The agent receives a job ID and gets a completion notification automatically. Ask to inspect a job's recent output or cancel it when needed. Use foreground execution for ordinary finite commands. Background mode is useful for servers and monitors. Keep Pi open. Reloading, changing sessions, or navigating the session tree cancels jobs and clears their logs.

Background launch confirms the job started, not that its changes have finished.
