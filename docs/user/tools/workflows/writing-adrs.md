# Writing ADRs

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install writing-adrs`. See [installation and scope](../../getting-started.md).

## When to use

Use `writing-adrs` when a task creates an architectural decision record or changes a recorded decision. It is model-invoked for ADR authoring and can also be requested explicitly after the decision is settled.

## Invocation

Use `/writing-adrs [decision or ADR path]` in Claude Code or `$writing-adrs` in ChatGPT. Provide the agreed behavior, values, limits, and trade-offs. The skill does not make unsettled product decisions on its own.

## What happens

The agent writes a concise decision contract: the decision first, exact values and rules, accepted trade-offs, and references to related ADRs. It avoids implementation identifiers, file paths within the ADR body, and verification claims.

When an agreed decision changes or reverses, the agent updates its existing ADR in place, removes outdated rules, and updates affected related ADRs and index entries. A distinct new decision gets a new numbered ADR.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. ADRs go in `docs/adr/NNNN-kebab-case-title.md`. The agent adds an index row for each new ADR and updates the existing row when an ADR changes. The package installs the authoring skill, not an ADR template in the target project.

## Example

Ask the agent to “use writing-adrs to record our agreed cache expiry policy” once the expiry values and failure behavior are decided.

## Pi usage

Use `/skill:writing-adrs [decision]`. The shared durable decision-document rules apply unchanged. Update an existing decision record in place when appropriate.
