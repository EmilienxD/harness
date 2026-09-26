# Writing ADRs

## When to use

Use `writing-adrs` when a task creates, changes, or supersedes an architectural decision record. It is model-invoked for ADR authoring and can also be requested explicitly after the decision is settled.

## Invocation

Use `/writing-adrs [decision or ADR path]` in Claude Code or `$writing-adrs` in ChatGPT. Provide the agreed behavior, values, limits, and trade-offs; the skill does not make unsettled product decisions on its own.

## What happens

The agent writes a concise decision contract: the decision first, exact values and rules, accepted trade-offs, and references to related ADRs. It avoids implementation identifiers, file paths within the ADR body, and verification claims. A reversal gets a new numbered record with a `supersedes` link, while the old record is marked superseded.

## Files and prerequisites

Both providers are supported. ADRs go in `docs/adr/NNNN-kebab-case-title.md`, and the agent adds an index row to `docs/adr/README.md`. The package installs the authoring skill, not an ADR template in the target project.

## Example

Ask the agent to “use writing-adrs to record our agreed cache expiry policy” once the expiry values and failure behavior are decided.
