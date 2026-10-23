# Setup help

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install setup-help`; see [installation and scope](../../getting-started.md).

## When to use

Use `setup-help` when you want to install, configure, or get something working with one verified action at a time.

## Invocation

Use `/setup-help [what to set up]` in Claude Code or `$setup-help [what to set up]` in ChatGPT. Give the target system and any current screen or setup state you can describe.

## What happens

The agent builds a complete checklist from your outline, project docs, the current screen, and prerequisites. Every reply gives one coherent current step with the values needed to complete it, followed by a divider and a short numbered “Still remaining” list. When you finish a step, the next moves into focus. New requirements are added to the checklist as they are discovered; the visible remainder never exceeds eight headline items.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. The package installs a skill only. Actual commands, files, accounts, and prerequisites depend on the setup task; no fixed project configuration is added by this package.

## Example

`/setup-help Configure this project's development environment on Windows` starts with the first required action and shows what remains.

## Pi usage

Use `/skill:setup-help [setup task]`. The shared setup checklist keeps one current verified action visible with the remaining checklist.
