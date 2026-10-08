# Grill me in cloud

## When to use

Use `grill-me-in-cloud` when a branching design interview benefits from a persistent visual board that can show comparisons, code excerpts, images, and interactive explanations.

## Invocation

Use `/grill-me-in-cloud [plan or design]` in Claude Code or `$grill-me-in-cloud` in ChatGPT. A board session is published round by round. Answer on the board, then copy its deterministic prompt into a provider session or let Aboard send it to the exact open terminal.

## What happens

The agent asks the current frontier of decisions, with options and recommendations. Its hook supplies fresh round and asset paths outside the project, uploads local explanation images, publishes the round, and returns the session URL. Only queued answers enter the next prompt. Unanswered questions retain their IDs in later rounds; the process continues until decisions are settled and you confirm shared understanding.

## Files and prerequisites

Both providers are supported through hooks. The board service must be available. Board connection can be configured in Harness config under `grill`; workspace-local `.harness/config.local.json` is ignored by project installs and can hold the URL and code. Drafts and round assets live outside the project.

## Example

`/grill-me-in-cloud Review the checkout redesign` opens a hosted decision round for that proposal.
