# Stop overthinking

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install stop-overthinking`; see [installation and scope](../../getting-started.md).

## Use it

Invoke `/stop-overthinking` in Claude Code or `$stop-overthinking` in ChatGPT when a discussion needs a short practical call. Add the decision if it is not clear from the conversation, for example `$stop-overthinking ship this release?`.

## What happens

The agent identifies any critical or serious issue, otherwise says whether to proceed, then gives concise next steps. This is useful when further analysis is no longer changing the decision.

## Practical note

Use it after the relevant risks and options are already in the conversation. The skill is deliberately brief: it surfaces serious blockers and the next action rather than reopening every tradeoff.

## Pi usage

Use `/skill:stop-overthinking`. The same concise practical-decision skill applies; it needs no native extension.
