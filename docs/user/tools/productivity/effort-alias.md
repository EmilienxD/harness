# Effort alias

Platforms: **Pi**.

Change Pi's reasoning effort with a short command.

## Install

```bash
harness install effort-alias --platform pi
```

Add `--scope user` to use it across projects.

See [Get started](../../getting-started.md) for installation options.

## Use it

Restart Pi or run `/reload` after installation. Use `/effort high` to set a supported level. Use `/effort` to choose from the levels supported by your active model. Unsupported values leave the setting unchanged. Cancelling the picker also leaves it unchanged. The command changes the current session only. Use Pi's native thinking controls to save startup defaults.
