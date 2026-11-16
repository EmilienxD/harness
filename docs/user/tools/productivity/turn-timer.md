# Turn timer

Platforms: **Pi**.

See how long Pi has been working on your latest request.

## Install

```bash
harness install turn-timer --platform pi
```

Add `--scope user` to use it across projects.

See [Get started](../../getting-started.md) for installation options.

## Use it

The timer starts when you submit a prompt. Tool calls and automatic continuations keep the same timer. After the turn finishes, a frozen duration appears above the editor. The next request starts a new timer. Reloading or changing sessions clears the display. No saved history or model settings are changed.
