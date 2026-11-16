# Statusline

Platforms: **Pi**.

See project, branch, model, effort, and context usage in a compact Pi footer.

## Install

```bash
harness install statusline --platform pi
```

Add `--scope user` to use it across projects.

See [Get started](../../getting-started.md) for installation options.

## Use it

Restart Pi or run `/reload` after installation. Read the context counters as used tokens, compaction threshold, and total window size.

For example, `125k/200k/256k` means 125,000 tokens used in a 256,000-token window, with normal compaction at 200,000. An `off` threshold means automatic compaction is disabled. Unknown values show `?`. Usage colors move from green through blue and yellow to red as context fills. The footer wraps or hides details when the terminal is narrow. Use only one custom footer extension at a time.
