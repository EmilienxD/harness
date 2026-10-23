# Read all ADRs

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install read-all-adrs`; see [installation and scope](../../getting-started.md).

## When to use

Use `read-all-adrs` when the current task needs every recorded architectural decision, not just a search result or summary of one ADR.

## Invocation

Use `/read-all-adrs [focus]` in Claude Code or `$read-all-adrs [focus]` in ChatGPT. The focus gives context for the later discussion; it does not narrow which ADR files are read.

## What happens

The agent reads every Markdown ADR in the project's `docs/adr/` directory from start to finish. It then has the full recorded decision context for subsequent work in the conversation.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. The project needs its ADRs under `docs/adr/`. This is a reading workflow: it does not create or revise records. Use `writing-adrs` for authoring.

## Example

`/read-all-adrs payment rules` loads all ADRs before discussing a payment-related change.

## Pi usage

Use `/skill:read-all-adrs`. Read every Markdown ADR completely. Large inventories still require enough model context; report any coverage limit rather than claiming an exhaustive read.
