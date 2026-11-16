# Tool inspector

Platforms: **Pi**.

Find out which tools Pi has and what arguments they accept.

## Install

```bash
harness install tool-inspector --platform pi
```

Add `--scope user` to use it across projects.

See [Get started](../../getting-started.md) for installation options.

## Use it

Restart Pi or run `/reload` after installation. Check the startup tool listing. Expand it with Ctrl+O for descriptions. Run `/tools` to inspect all configured tools. Run `/tools read` or substitute another tool name to inspect one. The report explains parameters and available output information. Inspection does not execute tools or send a request to the model.
