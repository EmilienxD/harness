# Grill me

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install grill-me`; see [installation and scope](../../getting-started.md).

## When to use

Use `grill-me` to stress-test a plan or design before implementation, especially when several decisions depend on one another.

## Invocation

Use `/grill-me [plan or design]` in Claude Code or `$grill-me [plan or design]` in ChatGPT. Give the current proposal and constraints you already know.

## What happens

The agent organizes decisions into a branching tree. Each round asks all questions ready to answer now, with up to four options and a recommendation per question. Your explicit answers settle those questions and uncover dependent ones for later rounds. The agent looks up facts it can find in the project and keeps unanswered questions open. It stops only when the frontier is empty and you confirm shared understanding.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. This skill conducts the exchange in the conversation and installs no project files or hook. Its output is an agreed solution summary, not implementation.

## Example

`/grill-me Our plan to split the API service into two deployments` begins the first decision round.

## Pi usage

Use `/skill:grill-me [plan or design]`. The shared frontier-based interview keeps explicit user decisions. It does not require the hosted board; use [grill-me-in-cloud](grill-me-in-cloud.md) for that workflow.
