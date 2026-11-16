# Decisions

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install decisions`. See [installation and scope](../../getting-started.md).

## Use it

Invoke `/decisions` in Claude Code or `$decisions` in ChatGPT after work or a design discussion. You can add a focus, such as `$decisions database migration`.

## What happens

The agent reviews choices already made in the current conversation and reports consequential ones that remain uncertain, with the strongest alternative and why it may be better.

If no meaningful uncertainty remains, it says so. For unresolved choices in a plan that you want to work through one at a time, use `next-decision`.

## Practical note

This skill uses the work visible in the current conversation. Give the agent a missing plan, decision record, or discussion transcript if the choices you want reviewed were made elsewhere. The output is a short review of uncertainty, not a list of every decision.

## Pi usage

Use `/skill:decisions`. The retrospective confidence review uses the conversation available to the current session. It does not recover missing history.
