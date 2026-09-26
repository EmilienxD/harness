# Read all ADRs

## When to use

Use `read-all-adrs` when the current task needs every recorded architectural decision, not just a search result or summary of one ADR.

## Invocation

Use `/read-all-adrs [focus]` in Claude Code or `$read-all-adrs [focus]` in ChatGPT. The focus gives context for the later discussion; it does not narrow which ADR files are read.

## What happens

The agent reads every Markdown ADR in the project's `docs/adr/` directory from start to finish. It then has the full recorded decision context for subsequent work in the conversation.

## Files and prerequisites

Both providers are supported. The project needs its ADRs under `docs/adr/`. This is a reading workflow: it does not create or revise records. Use `writing-adrs` for authoring.

## Example

`/read-all-adrs payment rules` loads all ADRs before discussing a payment-related change.
