# Test workflows

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install test-workflows`. See [Get started](../../getting-started.md) for provider and scope options.

## When to use it

Keep repeatable end-to-end checks for important user journeys. Identify workflows that need to be rerun after their covered code changes.

## Use it

Invoke `/test-workflows` in Claude Code, `$test-workflows` in ChatGPT, or `/skill:test-workflows` in Pi. Describe the capability and the observable behavior you want checked. Have the agent record preconditions, steps, expected results, and relevant coverage patterns. Ask it to check workflow status after code changes. Run affected workflows and confirm only the ones that actually pass.

Commit the workflow descriptions and their confirmation records together.

## Practical limits

Requires Python 3.11 or newer and Git. A confirmation records a completed check. It does not run the workflow for you. Changed covered code makes an earlier confirmation stale.
