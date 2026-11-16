# Copy all

Platforms: **Pi**.

Install with `harness install copy-all --platform pi`. See [installation and scope](../../getting-started.md).

`copy-all` adds Pi's `/copy-all` command. It waits for the agent to become idle, then copies user and assistant messages from the current session branch to the clipboard. Messages are labeled by role, images appear as `[image]`, and tool messages are excluded.

```powershell
harness install copy-all --platform pi --scope user
```

Restart Pi or run `/reload`, then use `/copy-all`.
