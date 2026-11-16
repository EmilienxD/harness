# Environment context

Platforms: **Pi**.

Give Pi basic operating-system and Git context automatically.

## Install

```bash
harness install environment-context --platform pi
```

Add `--scope user` to use it across projects.

See [Get started](../../getting-started.md) for installation options.

## Use it

Restart Pi or run `/reload` after installation. The agent receives your operating system, timezone, and session-start time. The timestamp is a session snapshot, not a live clock. Git status refreshes before each agent run. It includes changed, staged, untracked, and conflicted file counts. Long file lists are shortened while counts still cover the full status.

Git inspection is read-only. The agent should recheck status before destructive actions.
